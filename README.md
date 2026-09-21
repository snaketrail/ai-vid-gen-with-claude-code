# video-gen-ai

Local studio for 20–30 second vertical videos (TikTok / YouTube Shorts,
1080×1920). The video *is* a web page: scenes are DOM elements animated over a
timeline. Export drives that same page frame by frame in headless Chromium and
pipes the frames to ffmpeg.

Built for the English-for-Bulgarians shorts on
**[@stefdim.online](https://www.tiktok.com/@stefdim.online)** — that channel is
what this tool makes.

See [CLAUDE.md](CLAUDE.md) for the full build specification, and
[MAKING_A_VIDEO.md](MAKING_A_VIDEO.md) for the runbook that drives it.

## Quick start

Double-click **`run.bat`**, or:

```
.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

Then open http://127.0.0.1:8000.

First run creates the venv, installs dependencies and downloads Chromium for
Playwright (a few minutes). Later runs start immediately.

## Status

Working end to end. One click assembles a deck into scenes, generates the
images and voice-over, renders, and appends the cached outro:

- scene timeline, per-scene motion / text animation / transitions
- live preview with a scrubber, sharing one renderer with the export
- burned-in karaoke captions with correct Cyrillic
- ComfyUI images per scene, re-rollable one at a time
- ElevenLabs Bulgarian voice-over with word-level caption timing
- export to H.264 MP4, 1080×1920, yuv420p

## Content decks

A video is assembled from a **deck** — a JSON file of entries, one per scene.
Three ship as small demo decks so a fresh clone runs immediately:

| Deck | File | A scene teaches |
|---|---|---|
| `false_friends` | `content/false_friends.json` | An English word a Bulgarian misreads (`FABRIC` ≠ фабрика, = плат) |
| `word_explanations` | `content/word_explanations.json` | A useful English word, plainly defined |
| `synonyms` | `content/synonyms.json` | An upgrade for a basic word (`HAPPY` → delighted, thrilled) |

Edit those files freely. To keep a personal deck out of git, save it beside the
demo as `content/<name>.local.json` — that file is gitignored and takes
precedence when present.

## Layout

```
app/     FastAPI backend — projects, export pipeline
web/
  player/  the composition renderer: window.seek(t) draws one frame
  studio/  the editing UI
projects/  per-project project.json + generated assets
output/    exported MP4s
```

## The one rule

`web/player/player.js` must stay a **pure function of time**. No CSS
animations or transitions, no `requestAnimationFrame` motion, no `Date.now()`,
no `Math.random()`. If a frame depends on anything but `t` and the project
data, the exported video will flicker even though the preview looks fine.
