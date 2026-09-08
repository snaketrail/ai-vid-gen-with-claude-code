"""The branded end card, rendered once and reused by every video.

The outro is identical in every video, so rendering its ~130 frames on each
export is wasted work. Instead it is rendered a single time to
`content/brand/outro.mp4` and concatenated onto the end of each video.

The cache is keyed on the things that define it (logo bytes, voice-over,
text, hold, resolution), so changing any of them rebuilds it automatically.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Callable, Optional

from . import store
from .models import (
    Card,
    ImageAsset,
    Motion,
    Project,
    Scene,
    Settings,
    VoiceAsset,
)

BRAND_DIR = store.ROOT / "content" / "brand"
LOGO = BRAND_DIR / "logo.png"
VO = BRAND_DIR / "outro_vo.mp3"
CLIP = BRAND_DIR / "outro.mp4"
STAMP = BRAND_DIR / "outro.stamp.json"

TEXT = "Абонирайте се за stefdim.online за повече видеа."
HOLD = 1.0          # silent beat after the line, before the video ends
BG = "#0e1527"      # sampled from the logo PNG so its plate is invisible

# The outro is built through the normal player, so it is rendered by exactly
# the same code as everything else. It lives in its own throwaway project so
# it never pollutes the user's projects list.
BUILDER_ID = "_outro"


def _stamp() -> dict:
    from .timing import audio_duration

    return {
        "logo": LOGO.stat().st_size if LOGO.exists() else 0,
        "vo": VO.stat().st_size if VO.exists() else 0,
        "vo_dur": audio_duration(VO) if VO.exists() else 0.0,
        "text": TEXT,
        "hold": HOLD,
        "bg": BG,
    }


def is_current() -> bool:
    if not CLIP.exists() or not STAMP.exists():
        return False
    try:
        return json.loads(STAMP.read_text(encoding="utf-8")) == _stamp()
    except Exception:
        return False


def duration() -> float:
    """Length of the outro as it will actually appear in the export.

    Prefer the rendered clip's real duration over VO+hold: the encoder pads to
    whole frames, so the estimate is short by a few hundredths and the preview
    timeline would not match the exported file.
    """
    from .timing import audio_duration

    if CLIP.exists():
        try:
            return audio_duration(CLIP)
        except Exception:
            pass
    return round((audio_duration(VO) if VO.exists() else 0.0) + HOLD, 3)


def preview_scene() -> dict | None:
    """The outro described as a scene, for the studio preview only.

    The export still concatenates the cached clip; this exists so the
    scrubber's timeline matches the exported file instead of ending early.
    """
    if not LOGO.exists():
        return None
    return {
        "id": "sc_outro",
        "kind": "outro",
        "start": 0.0,
        "duration": duration(),
        "transition": "cut",
        "image": {
            "asset": "__brand__/logo.png",
            "placeholder_color": BG,
            "motion": {"type": "none", "amount": 1.0},
            "status": "ready",
            "locked": True,
        },
        "voice": {"text": TEXT, "duration": 0.0, "words": [], "status": "ready"},
        "card": {"word": "", "looks_like": "", "actually": ""},
    }


def build_project() -> Project:
    """A one-scene project containing just the outro."""
    from .timing import audio_duration, estimate_words

    store.assets_dir(BUILDER_ID).mkdir(parents=True, exist_ok=True)

    logo_asset = None
    if LOGO.exists():
        dest = store.assets_dir(BUILDER_ID) / "brand_logo.png"
        dest.write_bytes(LOGO.read_bytes())
        logo_asset = "assets/brand_logo.png"

    vo_asset = None
    vo_dur = 0.0
    words = []
    if VO.exists():
        dest = store.assets_dir(BUILDER_ID) / "outro_vo.mp3"
        dest.write_bytes(VO.read_bytes())
        vo_asset = "assets/outro_vo.mp3"
        vo_dur = audio_duration(dest)
        words = estimate_words(TEXT, vo_dur)

    project = Project(
        id=BUILDER_ID,
        settings=Settings(),
        scenes=[
            Scene(
                id="sc_outro",
                kind="outro",
                transition="cut",
                hold=HOLD,
                duration=vo_dur + HOLD if vo_dur else 3.0,
                image=ImageAsset(
                    asset=logo_asset,
                    placeholder_color=BG,
                    motion=Motion(type="none", amount=1.0),
                ),
                voice=VoiceAsset(
                    text=TEXT, asset=vo_asset, duration=vo_dur, words=words,
                    status="ready" if vo_asset else "empty",
                ),
                card=Card(),
            )
        ],
    )
    return store.save(project)


def ensure(
    base_url: str = "http://127.0.0.1:8000",
    on_progress: Optional[Callable[[float, str], None]] = None,
) -> Path | None:
    """Render the outro clip if missing or stale. Returns its path."""
    if not LOGO.exists():
        return None
    if is_current():
        return CLIP

    from . import audio as audio_mod
    from . import export as export_mod

    if on_progress:
        on_progress(0.0, "Rendering brand outro (one time only)")

    project = build_project()
    mix = audio_mod.build(project)
    out = export_mod.render(
        project, base_url=base_url, audio_path=mix, on_progress=on_progress
    )

    BRAND_DIR.mkdir(parents=True, exist_ok=True)
    CLIP.write_bytes(out.read_bytes())
    STAMP.write_text(json.dumps(_stamp(), ensure_ascii=False, indent=2), encoding="utf-8")
    out.unlink(missing_ok=True)
    return CLIP


def append_to(main: Path, out_path: Path) -> Path:
    """Concatenate the cached outro onto a rendered video.

    Re-encodes rather than stream-copying: the two files are produced by the
    same encoder settings, but concat with `-c copy` is fragile across
    separately-encoded inputs and can desync audio. At these lengths the cost
    is a few seconds.
    """
    if not CLIP.exists():
        return main

    filt = (
        "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]"
    )
    cmd = [
        "ffmpeg", "-y",
        "-i", str(main),
        "-i", str(CLIP),
        "-filter_complex", filt,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg failed appending outro:\n" + proc.stderr[-1500:])
    return out_path
