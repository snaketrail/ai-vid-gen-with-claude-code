"""Long-form lessons: build a 16:9 project from a lesson file, and render it.

A lesson file lives at content/lessons/<name>.json:

    {
      "id": "modal-verbs-a1",
      "title": "Modal Verbs", "level": "A1",
      "chapters": [
        {"id": "can", "title": "Can",
         "scenes": [{"template": "vocab", "duration": 8, "data": {...}}]}
      ]
    }

Each scene names a template in web/player/templates.js and gives it data.
The lesson file is the source of truth: building overwrites project.json, but
never touches the project's assets folder (CLAUDE.md 8: never delete
generated assets).

Command line:
    python -m app.lesson modal_verbs_a1            build the project
    python -m app.lesson modal_verbs_a1 --render   build, then render the MP4
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from pathlib import Path

from . import store
from .models import Project, Scene, Settings

LESSONS_DIR = store.ROOT / "content" / "lessons"
PORT = 8000
BASE_URL = f"http://127.0.0.1:{PORT}"


def lesson_path(name: str) -> Path:
    # A private lesson beside the demo takes precedence, like the decks.
    for candidate in (LESSONS_DIR / f"{name}.local.json", LESSONS_DIR / f"{name}.json"):
        if candidate.exists():
            return candidate
    raise FileNotFoundError(f"No lesson file: content/lessons/{name}.json")


def build(name: str) -> Project:
    data = json.loads(lesson_path(name).read_text(encoding="utf-8"))
    project_id = data.get("id") or name.replace("_", "-")

    scenes: list[Scene] = []
    for ch_i, chapter in enumerate(data.get("chapters", []), start=1):
        ch_id = chapter.get("id") or f"ch{ch_i:02d}"
        for sc_i, sc in enumerate(chapter.get("scenes", []), start=1):
            scenes.append(Scene(
                id=f"{ch_id}_{sc_i:02d}",
                kind="slide",
                template=sc["template"],
                data=sc.get("data", {}),
                duration=float(sc.get("duration", 6.0)),
                # Slides crossfade by default; the very first has nothing
                # to fade from.
                transition=sc.get("transition", "crossfade" if scenes else "cut"),
                chapter=chapter.get("title", ""),
            ))

    project = Project(
        id=project_id,
        format="lesson",
        meta={"title": data.get("title", ""), "level": data.get("level", "")},
        settings=Settings(width=1920, height=1080, fps=int(data.get("fps", 30))),
        scenes=scenes,
    )
    return store.save(project)


# ---------------------------------------------------------------- render

def _server_up() -> bool:
    import httpx

    try:
        return httpx.get(f"{BASE_URL}/api/health", timeout=1.0).status_code == 200
    except httpx.HTTPError:
        return False


def ensure_server() -> None:
    """The player loads over http (CLAUDE.md 8), so a render needs the app
    running. Reuse one if it is already up, otherwise start it in-process."""
    if _server_up():
        return
    import uvicorn

    from .main import app

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        if _server_up():
            return
        time.sleep(0.1)
    raise RuntimeError(f"Could not start the app on {BASE_URL}")


def render(project: Project, dedupe: bool = True, out_path: Path | None = None) -> Path:
    from . import export

    ensure_server()
    started = time.monotonic()

    def on_progress(frac: float, msg: str) -> None:
        print(f"\r[{frac * 100:5.1f}%] {msg:<60}", end="", flush=True)

    out = export.render(project, base_url=BASE_URL, on_progress=on_progress,
                        out_path=out_path, dedupe=dedupe)
    print(f"\nRendered {project.total_duration():.1f}s of video in "
          f"{time.monotonic() - started:.1f}s -> {out}")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("name", help="lesson file name in content/lessons, without .json")
    ap.add_argument("--render", action="store_true", help="render the MP4 after building")
    ap.add_argument("--no-dedupe", action="store_true", help="screenshot every frame")
    ap.add_argument("--out", type=Path, help="output MP4 path")
    args = ap.parse_args(argv)

    project = build(args.name)
    chapters = len({s.chapter for s in project.scenes})
    print(f"Built '{project.id}': {len(project.scenes)} slides, {chapters} chapters, "
          f"{project.total_duration():.1f}s")
    if args.render:
        render(project, dedupe=not args.no_dedupe, out_path=args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
