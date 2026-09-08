"""Auto-assemble a false-friends video from the deck.

This is the "one click" path: pick N unused entries, build the scenes, the
voice-over script and the cards, and hand back a project ready to render.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from .models import Card, ImageAsset, Motion, Project, Scene, VoiceAsset
from . import store

DECK_PATH = store.ROOT / "content" / "false_friends.json"

# Backgrounds cycle through a fixed palette so consecutive scenes never share
# a colour. Deep, desaturated tones keep the white card text readable.
PALETTE = [
    "#1e3a5f", "#7a2d2d", "#2c4a3e", "#4a2d5f",
    "#5f4a1e", "#1e4a5f", "#5f1e3a", "#2d3a2d",
]

MOTIONS = ["zoom_in", "pan_right", "zoom_out", "pan_left", "pan_up", "pan_down"]

# Rough Bulgarian speaking rate, used only to estimate scene length before the
# real voice-over exists. Replaced by the true MP3 duration once audio is in.
WORDS_PER_SECOND = 2.6
MIN_SCENE = 2.6

# Bulgarian numerals, so the intro line always agrees with how many
# false friends the video actually shows.
NUMERALS = {1: "Една", 2: "Две", 3: "Три", 4: "Четири", 5: "Пет", 6: "Шест"}


def intro_text(count: int) -> str:
    if count == 1:
        return "Една английска дума, която българите бъркат."
    n = NUMERALS.get(count, str(count))
    return f"{n} английски думи, които българите бъркат."


def load_deck() -> list[dict]:
    data = json.loads(DECK_PATH.read_text(encoding="utf-8"))
    return data["items"]


def estimate_duration(text: str) -> float:
    words = max(1, len(text.split()))
    return round(max(MIN_SCENE, words / WORDS_PER_SECOND + 0.9), 2)


def pick_items(deck: list[dict], count: int, used: set[str], seed: int | None) -> list[dict]:
    """Prefer entries this project has not used yet, so repeat runs vary."""
    fresh = [d for d in deck if d["id"] not in used]
    pool = fresh if len(fresh) >= count else deck
    rng = random.Random(seed)
    return rng.sample(pool, min(count, len(pool)))


def build(
    project_id: str,
    count: int = 3,
    seed: int | None = None,
    intro: bool = True,
    used: set[str] | None = None,
) -> Project:
    """Create (or overwrite) a project with freshly assembled scenes."""
    deck = load_deck()
    items = pick_items(deck, count, used or set(), seed)

    try:
        project = store.load(project_id)
    except FileNotFoundError:
        project = Project(id=project_id)

    project.scenes = []
    project.settings.caption_style = "karaoke"

    idx = 0
    if intro:
        intro_line = intro_text(len(items))
        project.scenes.append(
            Scene(
                id="sc_intro",
                duration=estimate_duration(intro_line),
                transition="cut",
                image=ImageAsset(
                    prompt=(
                        "an open english dictionary page in warm lamplight, "
                        "shallow depth of field, cinematic still life"
                    ),
                    placeholder_color=PALETTE[0],
                    motion=Motion(type="zoom_in", amount=1.10),
                    status="stale",
                ),
                voice=VoiceAsset(text=intro_line),
                card=Card(word="FALSE FRIENDS", looks_like="", actually=""),
            )
        )
        idx = 1

    for i, item in enumerate(items):
        project.scenes.append(
            Scene(
                id=f"sc_{item['id']}",
                duration=estimate_duration(item["vo"]),
                transition="crossfade" if (i or intro) else "cut",
                image=ImageAsset(
                    prompt=item.get("prompt", ""),
                    placeholder_color=PALETTE[(i + idx) % len(PALETTE)],
                    motion=Motion(type=MOTIONS[(i + idx) % len(MOTIONS)], amount=1.13),
                    # No file yet: the studio generates it, and the flat colour
                    # stands in until then so the video always renders.
                    status="stale" if item.get("prompt") else "empty",
                ),
                voice=VoiceAsset(text=item["vo"]),
                card=Card(
                    word=item["word"],
                    looks_like=item["looks_like"],
                    actually=item["actually"],
                ),
            )
        )

    return store.save(project)


def deck_ids_in(project: Project) -> set[str]:
    return {s.id.replace("sc_", "", 1) for s in project.scenes}
