"""Word timings for captions.

The preferred source is ElevenLabs' /with-timestamps endpoint, which returns
real character-level alignment (see tts.py, Phase 2b). When audio arrives as a
plain file with no alignment — for example generated through the Claude
ElevenLabs connector — we distribute the known total duration across the words
instead.

The distribution is weighted by syllable count rather than split evenly:
"университетски" takes far longer to say than "не", and an even split would
drift badly by the end of a sentence.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .models import Word

# Bulgarian vowels (Cyrillic) plus Latin, since lines mix in English words.
VOWELS = set("аъоуеияюAEIOUYaeiouy")

# Leading/trailing silence a TTS clip typically carries.
LEAD_IN = 0.12
TAIL = 0.10


def audio_duration(path: Path) -> float:
    """Exact duration via ffprobe. Never trust a model's own estimate."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True, text=True, check=True,
    )
    return round(float(out.stdout.strip()), 3)


def syllables(word: str) -> int:
    """Vowel-group count — a good proxy for spoken length in Bulgarian."""
    core = re.sub(r"[^\w]", "", word, flags=re.UNICODE)
    n = 0
    prev_vowel = False
    for ch in core:
        is_vowel = ch in VOWELS
        if is_vowel and not prev_vowel:
            n += 1
        prev_vowel = is_vowel
    return max(1, n)


def estimate_words(text: str, duration: float) -> list[Word]:
    """Spread `duration` across the words of `text`, weighted by syllables.

    Punctuation earns a small extra pause, so captions do not run ahead of
    the voice across sentence boundaries.
    """
    tokens = text.split()
    if not tokens or duration <= 0:
        return []

    weights: list[float] = []
    for tok in tokens:
        w = float(syllables(tok))
        if tok.endswith((".", "!", "?")):
            w += 1.1          # full stop: a real breath
        elif tok.endswith((",", ";", ":")):
            w += 0.5
        weights.append(w)

    speech = max(0.1, duration - LEAD_IN - TAIL)
    total = sum(weights)
    words: list[Word] = []
    cursor = LEAD_IN
    for tok, w in zip(tokens, weights):
        span = speech * (w / total)
        words.append(
            Word(word=tok, start=round(cursor, 3), end=round(cursor + span, 3))
        )
        cursor += span
    return words
