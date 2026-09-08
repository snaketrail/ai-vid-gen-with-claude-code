"""Project persistence, timeline recomputation and content hashing.

Every file read/write here is explicitly utf-8: Windows defaults to cp1251/
cp1252 and would mangle Bulgarian text (CLAUDE.md section 8).
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from .models import VOICE_TAIL, DEFAULT_SCENE_DURATION, Project, Scene

ROOT = Path(__file__).resolve().parent.parent
PROJECTS_DIR = ROOT / "projects"
OUTPUT_DIR = ROOT / "output"
WEB_DIR = ROOT / "web"


def project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


def assets_dir(project_id: str) -> Path:
    return project_dir(project_id) / "assets"


def project_file(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


def short_hash(*parts: object) -> str:
    """Short SHA-256 over the exact inputs that produce an asset.

    Used as the cache key: if a file named with this hash already exists we
    reuse it and do no work (CLAUDE.md 5.1).
    """
    joined = "\x1f".join(str(p) for p in parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:12]


def recompute_timeline(project: Project) -> Project:
    """Derive every scene's duration and start time.

    Audio is the source of truth: a scene lasts as long as its voice-over
    plus a short tail, and starts where the previous scene ended.
    """
    cursor = 0.0
    for scene in project.scenes:
        if scene.voice.duration > 0:
            scene.duration = round(scene.voice.duration + VOICE_TAIL + scene.hold, 3)
        elif scene.duration <= 0:
            scene.duration = DEFAULT_SCENE_DURATION
        scene.start = round(cursor, 3)
        cursor += scene.duration
    return project


def list_projects() -> list[str]:
    if not PROJECTS_DIR.exists():
        return []
    return sorted(p.name for p in PROJECTS_DIR.iterdir() if (p / "project.json").exists())


def load(project_id: str) -> Project:
    path = project_file(project_id)
    if not path.exists():
        raise FileNotFoundError(f"No such project: {project_id}")
    data = json.loads(path.read_text(encoding="utf-8"))
    return recompute_timeline(Project.model_validate(data))


def save(project: Project) -> Project:
    recompute_timeline(project)
    assets_dir(project.id).mkdir(parents=True, exist_ok=True)
    project_file(project.id).write_text(
        json.dumps(project.model_dump(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return project


def create(project_id: str) -> Project:
    if project_file(project_id).exists():
        raise FileExistsError(f"Project already exists: {project_id}")
    return save(Project(id=project_id))


def delete(project_id: str) -> None:
    shutil.rmtree(project_dir(project_id), ignore_errors=True)


def next_scene_id(project: Project) -> str:
    existing = {s.id for s in project.scenes}
    n = 1
    while f"sc_{n:02d}" in existing:
        n += 1
    return f"sc_{n:02d}"


def add_scene(project: Project, scene: Scene | None = None) -> Scene:
    scene = scene or Scene(id=next_scene_id(project))
    project.scenes.append(scene)
    return scene
