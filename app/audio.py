"""Build the single mixed audio track for a project.

Each scene's voice-over is delayed to its start time and the results are mixed
into one AAC file. Its length defines the video's length; the visual timeline
follows it (CLAUDE.md 4.3).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from .models import Project
from . import store


def build(project: Project) -> Path | None:
    """Return the mixed audio path, or None if no scene has a voice-over."""
    adir = store.assets_dir(project.id)
    adir.mkdir(parents=True, exist_ok=True)

    clips: list[tuple[Path, float]] = []
    for scene in project.scenes:
        if not scene.voice.asset:
            continue
        path = store.project_dir(project.id) / scene.voice.asset
        if path.exists():
            clips.append((path, scene.start))

    if not clips:
        return None

    total = project.total_duration()
    key = store.short_hash(
        *[f"{p.name}@{s}" for p, s in clips],
        total,
        project.music.asset,
        project.music.volume,
    )
    out = adir / f"mix_{key}.m4a"
    if out.exists():
        return out

    cmd: list[str] = ["ffmpeg", "-y"]
    for path, _ in clips:
        cmd += ["-i", str(path)]

    music_idx = None
    if project.music.asset:
        mpath = store.project_dir(project.id) / project.music.asset
        if mpath.exists():
            music_idx = len(clips)
            cmd += ["-stream_loop", "-1", "-i", str(mpath)]

    parts: list[str] = []
    labels: list[str] = []
    for i, (_, start) in enumerate(clips):
        ms = int(round(start * 1000))
        # adelay needs a value per channel; `all=1` covers both without
        # having to know the source layout.
        parts.append(f"[{i}:a]adelay={ms}:all=1[v{i}]")
        labels.append(f"[v{i}]")

    if music_idx is not None:
        vol = project.music.volume
        fade_at = max(0.0, total - 1.5)
        parts.append(
            f"[{music_idx}:a]volume={vol},afade=t=out:st={fade_at}:d=1.5[mus]"
        )
        labels.append("[mus]")

    # normalize=0 keeps each voice at full level; with normalize=1 ffmpeg
    # quietens everything as the number of inputs grows.
    parts.append(
        f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0"
        f",apad,atrim=0:{total}[out]"
    )

    cmd += [
        "-filter_complex", ";".join(parts),
        "-map", "[out]",
        "-c:a", "aac", "-b:a", "192k",
        str(out),
    ]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            "ffmpeg failed building the audio mix:\n" + proc.stderr[-1500:]
        )
    return out
