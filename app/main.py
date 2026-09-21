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
from . import comfy as comfy_mod
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
        "comfy": comfy_mod.health(),
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
def api_get_project(project_id: str, with_outro: bool = True) -> dict:
    """The project as the player should draw it.

    The branded outro is appended here rather than stored as a scene: it is a
    fixed clip concatenated at export time, but the preview must include it or
    the scrubber's timeline would be shorter than the exported video. The
    studio's own editing calls pass with_outro=false so it never gets saved
    back as real data.
    """
    try:
        project = store.load(project_id)
    except FileNotFoundError:
        raise HTTPException(404, f"No such project: {project_id}")

    data = project.model_dump()
    if with_outro and project_id != outro_mod.BUILDER_ID:
        extra = outro_mod.preview_scene()
        if extra and project.scenes:
            extra["start"] = project.total_duration()
            data["scenes"] = data["scenes"] + [extra]
    return data


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
    deck: str = "false_friends"


@app.post("/api/projects/{project_id}/assemble")
def api_assemble(project_id: str, body: AssembleReq) -> dict:
    """One click: build a full deck-based video (false friends, word
    explanations, or synonyms — same scene shape, different content file)."""
    # Avoid words any earlier video already taught, not just this project's.
    used: set[str] = assemble_mod.deck_ids_everywhere()
    try:
        used |= assemble_mod.deck_ids_in(store.load(project_id))
    except FileNotFoundError:
        pass
    p = assemble_mod.build(
        project_id, count=body.count, seed=body.seed, intro=body.intro,
        used=used, deck=body.deck,
    )
    return p.model_dump()


@app.get("/api/checkpoints")
def api_checkpoints() -> list[str]:
    return comfy_mod.checkpoints()


@app.post("/api/projects/{project_id}/images")
def api_generate_images(project_id: str, scene_id: str | None = None) -> dict:
    """Generate the missing (or one specific) scene image via ComfyUI.

    Runs strictly one at a time: two parallel generations OOM on 6 GB VRAM.
    """
    project = store.load(project_id)
    job_id = f"images_{project_id}"

    with _jobs_lock:
        if _jobs.get(job_id, {}).get("status") == "running":
            raise HTTPException(409, "Image generation already running.")
        _jobs[job_id] = {"status": "running", "progress": 0.0, "message": "Starting"}

    def run() -> None:
        try:
            targets = [
                s for s in project.scenes
                if s.image.prompt
                and not s.image.locked
                and (scene_id is None or s.id == scene_id)
                and (scene_id is not None or s.image.status != "ready")
            ]
            if not targets:
                with _jobs_lock:
                    _jobs[job_id].update(
                        status="done", progress=1.0, message="Nothing to generate"
                    )
                return

            import random

            for i, scene in enumerate(targets):
                seed = scene.image.seed or random.randint(1, 2**31 - 1)
                if scene_id is not None:
                    seed = random.randint(1, 2**31 - 1)  # re-roll

                h = store.short_hash(
                    scene.image.prompt, seed, project.settings.checkpoint,
                    project.settings.negative_prompt,
                    comfy_mod.GEN_WIDTH, comfy_mod.GEN_HEIGHT,
                )
                name = f"{scene.id}_img_{h}.png"
                dest = store.assets_dir(project_id) / name

                base = i / len(targets)
                span = 1 / len(targets)

                def prog(f: float, msg: str, _b=base, _s=span, _sc=scene) -> None:
                    with _jobs_lock:
                        _jobs[job_id].update(
                            progress=_b + f * _s,
                            message=f"{_sc.id}: {msg}",
                        )

                if not dest.exists():   # cache hit: nothing to do
                    comfy_mod.generate(
                        scene.image.prompt, seed, dest,
                        checkpoint=project.settings.checkpoint
                        or "photon_v1.safetensors",
                        negative=project.settings.negative_prompt,
                        on_progress=prog,
                    )

                scene.image.seed = seed
                scene.image.asset = f"assets/{name}"
                scene.image.hash = h
                scene.image.status = "ready"
                store.save(project)

            with _jobs_lock:
                _jobs[job_id].update(
                    status="done", progress=1.0,
                    message=f"Generated {len(targets)} image(s)",
                )
        except Exception as e:
            with _jobs_lock:
                _jobs[job_id].update(status="error", message=str(e))

    threading.Thread(target=run, daemon=True).start()
    return {"job": job_id}


@app.get("/api/outro")
def api_outro() -> dict:
    """Outro length, so the studio scrubber can span the full export."""
    return {
        "exists": outro_mod.LOGO.exists(),
        "duration": outro_mod.duration(),
        "cached": outro_mod.is_current(),
    }


@app.get("/api/deck")
def api_deck(deck: str = "false_friends") -> list[dict]:
    return assemble_mod.load_deck(deck)


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
                merged = out.with_name(out.stem + "_tmp.mp4")
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
    # Avoid words any earlier video already taught, not just this project's.
    used: set[str] = assemble_mod.deck_ids_everywhere()
    try:
        used |= assemble_mod.deck_ids_in(store.load(project_id))
    except FileNotFoundError:
        pass
    assemble_mod.build(
        project_id, count=body.count, seed=body.seed, intro=body.intro,
        used=used, deck=body.deck,
    )
    # Generate images first if ComfyUI is available, then render. Without it
    # the flat placeholder colours are used, so a video still comes out.
    if comfy_mod.health():
        return api_make_with_images(project_id)
    return api_export(project_id)


def api_make_with_images(project_id: str) -> dict:
    """Generate all missing images, then export — as one job."""
    job_id = f"export_{project_id}"
    with _jobs_lock:
        if _jobs.get(job_id, {}).get("status") == "running":
            raise HTTPException(409, "A render is already running.")
        _jobs[job_id] = {"status": "running", "progress": 0.0, "message": "Starting"}

    def run() -> None:
        import random

        def set_job(**kw: Any) -> None:
            with _jobs_lock:
                _jobs[job_id].update(**kw)

        try:
            project = store.load(project_id)
            targets = [
                s for s in project.scenes
                if s.image.prompt and not s.image.locked and s.image.status != "ready"
            ]
            for i, scene in enumerate(targets):
                seed = scene.image.seed or random.randint(1, 2**31 - 1)
                h = store.short_hash(
                    scene.image.prompt, seed, project.settings.checkpoint,
                    project.settings.negative_prompt,
                    comfy_mod.GEN_WIDTH, comfy_mod.GEN_HEIGHT,
                )
                name = f"{scene.id}_img_{h}.png"
                dest = store.assets_dir(project_id) / name
                base, span = i / max(1, len(targets)), 1 / max(1, len(targets))

                def prog(f: float, msg: str, _b=base, _s=span, _sc=scene) -> None:
                    set_job(
                        progress=(_b + f * _s) * 0.55,
                        message=f"Image {_sc.id}: {int(f * 100)}%",
                    )

                if not dest.exists():
                    comfy_mod.generate(
                        scene.image.prompt, seed, dest,
                        checkpoint=project.settings.checkpoint
                        or "photon_v1.safetensors",
                        negative=project.settings.negative_prompt,
                        on_progress=prog,
                    )
                scene.image.seed = seed
                scene.image.asset = f"assets/{name}"
                scene.image.hash = h
                scene.image.status = "ready"
                store.save(project)

            project = store.load(project_id)
            outro_clip = outro_mod.ensure(base_url=BASE_URL)
            set_job(progress=0.58, message="Building audio")
            audio_path = audio_mod.build(project)

            out = export_mod.render(
                project, base_url=BASE_URL, audio_path=audio_path,
                on_progress=lambda f, m: set_job(
                    progress=0.58 + f * 0.37, message=m
                ),
            )
            if outro_clip:
                set_job(progress=0.96, message="Adding outro")
                merged = out.with_name(out.stem + "_tmp.mp4")
                outro_mod.append_to(out, merged)
                merged.replace(out)

            set_job(status="done", progress=1.0, message=f"Done: {out.name}")
        except Exception as e:
            set_job(status="error", message=str(e))

    threading.Thread(target=run, daemon=True).start()
    return {"job": job_id}


@app.get("/api/jobs/{job_id}")
def api_job(job_id: str) -> dict:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "No such job")
    return job


@app.get("/api/videos")
def api_videos() -> list[dict]:
    """Every rendered MP4 in the output folder, newest first."""
    if not store.OUTPUT_DIR.exists():
        return []
    out = []
    for f in store.OUTPUT_DIR.glob("*.mp4"):
        if f.stem.startswith("_"):
            continue  # internal build artifacts
        st = f.stat()
        out.append({
            "name": f.name,
            "stem": f.stem,
            "size": st.st_size,
            "mtime": st.st_mtime,
        })
    out.sort(key=lambda v: v["mtime"], reverse=True)
    return out


@app.get("/api/video/{name}")
def api_video(name: str) -> FileResponse:
    """Serve a rendered video by filename (not by project id)."""
    target = (store.OUTPUT_DIR / name).resolve()
    base = store.OUTPUT_DIR.resolve()
    if not str(target).startswith(str(base)) or not target.exists():
        raise HTTPException(404, "Not found")
    return FileResponse(target, media_type="video/mp4")


@app.post("/api/reveal")
def api_reveal() -> dict:
    """Open the output folder in Explorer."""
    import subprocess

    store.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    subprocess.Popen(["explorer", str(store.OUTPUT_DIR)])
    return {"opened": str(store.OUTPUT_DIR)}


def _latest_render(project_id: str) -> Path | None:
    """Newest MP4 for a project, now that filenames carry a timestamp."""
    files = sorted(
        store.OUTPUT_DIR.glob(f"{project_id}-*.mp4"),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    if not files:
        legacy = store.OUTPUT_DIR / f"{project_id}.mp4"
        return legacy if legacy.exists() else None
    return files[0]


@app.get("/api/output/{project_id}/info")
def api_output_info(project_id: str) -> dict:
    """Whether a render exists, so the UI can show it on load."""
    path = _latest_render(project_id)
    if path is None:
        return {"exists": False}
    return {
        "exists": True,
        "size": path.stat().st_size,
        "mtime": path.stat().st_mtime,
    }


@app.get("/api/output/{project_id}")
def api_output(project_id: str) -> FileResponse:
    path = _latest_render(project_id)
    if path is None:
        raise HTTPException(404, "Not rendered yet")
    return FileResponse(path, media_type="video/mp4")


# ---------------------------------------------------------------- media

@app.get("/media/{project_id}/__brand__/{name}")
def api_brand_media(project_id: str, name: str) -> FileResponse:
    """Shared branding assets, not owned by any single project."""
    target = (outro_mod.BRAND_DIR / name).resolve()
    if not str(target).startswith(str(outro_mod.BRAND_DIR.resolve())) or not target.exists():
        raise HTTPException(404, "Not found")
    return FileResponse(target)


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
