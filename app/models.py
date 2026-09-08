"""Pydantic models mirroring project.json (see CLAUDE.md section 5)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field

MotionType = Literal[
    "none", "zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down"
]
OverlayAnim = Literal["none", "fade_up", "pop", "slide_in"]
Transition = Literal["cut", "crossfade"]
AssetStatus = Literal["empty", "stale", "generating", "ready", "error"]

# Fallback duration for a scene with no voice-over, and the pause appended
# after speech ends so scenes do not cut the instant the voice stops.
DEFAULT_SCENE_DURATION = 3.0
VOICE_TAIL = 0.3
CROSSFADE_DURATION = 0.4


class Motion(BaseModel):
    type: MotionType = "zoom_in"
    amount: float = 1.12


class ImageAsset(BaseModel):
    prompt: str = ""
    seed: int = 0
    asset: Optional[str] = None
    hash: Optional[str] = None
    status: AssetStatus = "empty"
    locked: bool = False
    motion: Motion = Field(default_factory=Motion)
    # Phase 1 only: flat colour stand-in so the pipeline can be proven
    # before ComfyUI exists. Phase 3 replaces this with real images.
    placeholder_color: str = "#2b3a55"


class Word(BaseModel):
    word: str
    start: float
    end: float


class VoiceAsset(BaseModel):
    text: str = ""
    asset: Optional[str] = None
    words: list[Word] = Field(default_factory=list)
    duration: float = 0.0
    hash: Optional[str] = None
    status: AssetStatus = "empty"
    locked: bool = False


class Overlay(BaseModel):
    text: str = ""
    position: Literal["top", "center", "bottom"] = "top"
    font_size: int = 96
    animation: OverlayAnim = "fade_up"


class Scene(BaseModel):
    id: str
    # start/duration are always recomputed by the backend, never trusted
    # from the client (CLAUDE.md 5.2).
    start: float = 0.0
    duration: float = DEFAULT_SCENE_DURATION
    transition: Transition = "cut"
    image: ImageAsset = Field(default_factory=ImageAsset)
    voice: VoiceAsset = Field(default_factory=VoiceAsset)
    overlay: Overlay = Field(default_factory=Overlay)


class Settings(BaseModel):
    width: int = 1080
    height: int = 1920
    fps: int = 30
    checkpoint: str = ""
    negative_prompt: str = "blurry, watermark, text, deformed"
    voice_id: str = ""
    voice_model: str = "eleven_multilingual_v2"
    caption_style: Literal["karaoke", "simple"] = "karaoke"
    theme: str = "bold-white"


class Music(BaseModel):
    asset: Optional[str] = None
    volume: float = 0.18


class Project(BaseModel):
    id: str
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    settings: Settings = Field(default_factory=Settings)
    scenes: list[Scene] = Field(default_factory=list)
    music: Music = Field(default_factory=Music)
    output: Optional[str] = None

    def total_duration(self) -> float:
        if not self.scenes:
            return 0.0
        last = self.scenes[-1]
        return round(last.start + last.duration, 3)
