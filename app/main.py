"""FastAPI app: project CRUD, static serving, export.

Assets are served over http://127.0.0.1:8000/media/... rather than file://,
because Playwright and fetch both behave badly with local file paths
(CLAUDE.md section 8).
"""

from __future__ import annotations

import shutil
import threading
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import assemble as assemble_mod
from . import audio as audio_mod
from . import export as export_mod
from . import outro as outro_mod
from . import store
from .models import Project, Scene

app = FastAPI(title="video-gen-ai")

PORT = 8000
BASE_URL = f"http://127.0.0.1:{PORT}"

# In-memory job state. Phase 4 replaces this with the full queue in jobs.py.
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()


# ---------------------------------------------------------------- projects

class CreateProject(BaseModel):
    id: str


@app.get("/api/health")
def health() -> dict:
    return {
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
        "comfy": False,       # Phase 3
        "elevenlabs": False,  # Phase 2
    }


@app.get("/api/projects")
def api_list_projects() -> list[str]:
    return store.list_projects()


@app.post("/api/projects")
def api_create_project(body: CreateProject) -> dict:
    try:
        p = store.create(body.id)
    except FileExistsError as e:
        raise HTTPException(409, str(e))
    return p.model_dump()


@app.get("/api/projects/{project_id}")
def api_get_project(project_id: str) -> dict:
    try:
        return store.load(project_id).model_dump()
    except FileNotFoundError:
        raise HTTPException(404, f"No such project: {project_id}")


@app.put("/api/projects/{project_id}")
def api_put_project(project_id: str, body: dict) -> dict:
    """Replace the whole project document (studio autosave)."""
    body["id"] = project_id
    project = Project.model_validate(body)
    return store.save(project).model_dump()


@app.post("/api/projects/{project_id}/scenes")
def api_add_scene(project_id: str) -> dict:
    project = store.load(project_id)
    store.add_scene(project)
    return store.save(project).model_dump()


@app.delete("/api/projects/{project_id}/scenes/{scene_id}")
def api_delete_scene(project_id: str, scene_id: str) -> dict:
    project = store.load(project_id)
    project.scenes = [s for s in project.scenes if s.id != scene_id]
    return store.save(project).model_dump()


class AssembleReq(BaseModel):
    count: int = 3
    seed: int | None = None
    intro: bool = True


@app.post("/api/projects/{project_id}/assemble")
def api_assemble(project_id: str, body: AssembleReq) -> dict:
    """One click: build a full false-friends video from the deck."""
    used: set[str] = set()
    try:
        used = assemble_mod.deck_ids_in(store.load(project_id))
    except FileNotFoundError:
        pass
    p = assemble_mod.build(
        project_id, count=body.count, seed=body.seed, intro=body.intro, used=used
    )
    return p.model_dump()


@app.get("/api/deck")
def api_deck() -> list[dict]:
    return assemble_mod.load_deck()


# ---------------------------------------------------------------- export

@app.post("/api/projects/{project_id}/export")
def api_export(project_id: str) -> dict:
    project = store.load(project_id)
    job_id = f"export_{project_id}"

    with _jobs_lock:
        running = _jobs.get(job_id, {}).get("status") == "running"
        if running:
            raise HTTPException(409, "An export is already running.")
        _jobs[job_id] = {"status": "running", "progress": 0.0, "message": "Starting"}

    def run() -> None:
        def on_progress(frac: float, msg: str) -> None:
            with _jobs_lock:
                _jobs[job_id].update(progress=frac, message=msg)

        try:
            # The branded outro is identical in every video, so it is rendered
            # once and cached, then concatenated on. Only the first export
            # after a branding change pays for it.
            def outro_progress(f: float, msg: str) -> None:
                on_progress(f * 0.35, msg)

            outro_clip = outro_mod.ensure(
                base_url=BASE_URL, on_progress=outro_progress
            )

            on_progress(0.36, "Building audio")
            audio_path = audio_mod.build(project)

            def body_progress(f: float, msg: str) -> None:
                on_progress(0.36 + f * 0.58, msg)

            out = export_mod.render(
                project, base_url=BASE_URL, audio_path=audio_path,
                on_progress=body_progress if outro_clip else on_progress,
            )

            if outro_clip:
                on_progress(0.95, "Adding outro")
                merged = store.OUTPUT_DIR / f"{project.id}_final.mp4"
                outro_mod.append_to(out, merged)
                merged.replace(out)
            with _jobs_lock:
                _jobs[job_id].update(
                    status="done", progress=1.0,
                    message=f"Done: {out.name}", output=str(out),
                )
        except Exception as e:  # surfaced verbatim to the UI
            with _jobs_lock:
                _jobs[job_id].update(status="error", message=str(e))

    threading.Thread(target=run, daemon=True).start()
    return {"job": job_id}


@app.post("/api/projects/{project_id}/make")
def api_make(project_id: str, body: AssembleReq) -> dict:
    """The one button: assemble scenes from the deck, then render the MP4.

    Only scenes whose voice-over already has audio get sound; lines without a
    matching file are silent but still timed, so the video always completes.
    """
    used: set[str] = set()
    try:
        used = assemble_mod.deck_ids_in(store.load(project_id))
    except FileNotFoundError:
        pass
    assemble_mod.build(
        project_id, count=body.count, seed=body.seed, intro=body.intro, used=used
    )
    return api_export(project_id)


@app.get("/api/jobs/{job_id}")
def api_job(job_id: str) -> dict:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "No such job")
    return job


@app.get("/api/output/{project_id}")
def api_output(project_id: str) -> FileResponse:
    path = store.OUTPUT_DIR / f"{project_id}.mp4"
    if not path.exists():
        raise HTTPException(404, "Not rendered yet")
    return FileResponse(path, media_type="video/mp4")


# ---------------------------------------------------------------- media

@app.get("/media/{project_id}/{file_path:path}")
def api_media(project_id: str, file_path: str) -> FileResponse:
    base = store.project_dir(project_id).resolve()
    target = (base / file_path).resolve()
    # Path traversal guard: the resolved path must stay inside the project.
    if not str(target).startswith(str(base)) or not target.exists():
        raise HTTPException(404, "Not found")
    return FileResponse(target)


# ---------------------------------------------------------------- static

WEB = store.WEB_DIR
app.mount("/player", StaticFiles(directory=WEB / "player"), name="player")
app.mount("/studio", StaticFiles(directory=WEB / "studio", html=True), name="studio")


@app.get("/")
def index() -> RedirectResponse:
    return RedirectResponse("/studio/index.html")
