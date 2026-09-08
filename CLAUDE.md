# video-gen-ai — Build Specification

> This file is the single source of truth for Claude Code. Read it fully before
> writing any code. Follow the phases in order; do not skip ahead.
> Personal-use project, single user, runs entirely on localhost, launched and
> used from VS Code on this machine only.

---

## 1. What this is

A local studio for making **20–30 second vertical videos** (TikTok / YouTube
Shorts, 1080×1920, 9:16), specifically **English/Bulgarian "false friends"**
explainers: one false friend per scene.

**The core idea: the video is a web page.** There is no video model and no
frame compositing in ffmpeg. A video is a stack of HTML elements — a background
image, text layers, captions — animated with CSS over a timeline, played like a
slideshow. Think of it as a PowerPoint made of DOM nodes.

Export works by **driving that same page frame by frame in headless Chromium**,
screenshotting each frame, and piping the frames to ffmpeg to make an MP4.

The single most important consequence, and the reason for this architecture:

> **The preview and the export are the same renderer.** What the user sees in
> the browser is literally what gets encoded — not an approximation of it.
> Never introduce a second rendering path that could drift from the first.

The second defining requirement is **granular regeneration**: the user sees
every part of the video laid out and can re-roll *one* image, *one* voice line,
or *one* piece of text without touching anything else.

**Non-goals:** no cloud deploy, no auth, no multi-user, no monetisation, no
packaging or distribution, no AI video models. Never add these.

---

## 2. Hardware & environment (verified on this machine)

| Thing | Value |
|---|---|
| OS | Windows 11 |
| Python | 3.12.10 (`python` on PATH) |
| ffmpeg | 9.0 full build, on PATH; verified `image2pipe`, `libx264`, `aac` all work |
| GPU | NVIDIA RTX 3050 Laptop, **6 GB VRAM** |
| ComfyUI | Runs at **http://127.0.0.1:8188** (user starts it separately) |
| Playwright | **Not yet installed** — Phase 1 installs it (`pip install playwright` + `playwright install chromium`) |
| Shell | PowerShell primary |

The 6 GB VRAM limit applies **only to ComfyUI image generation**. Because
there is no video model, VRAM is not a constraint on rendering at all. Still:
**queue ComfyUI jobs strictly serially**, since two parallel generations will
OOM on 6 GB.

---

## 3. Chosen stack (decisions already made — do not re-litigate)

| Concern | Decision |
|---|---|
| Composition | **HTML + CSS + vanilla JS.** Scenes are DOM elements on a timeline. |
| Preview | The composition page itself, in an iframe at 1080×1920, scaled down to fit. |
| Export | **Playwright headless Chromium**, deterministic frame-by-frame seek + screenshot → piped to ffmpeg. |
| Images | **ComfyUI HTTP API** at `http://127.0.0.1:8188`. User has a Pony model and a photorealism model. |
| Voice-over | **ElevenLabs**, `eleven_multilingual_v2`, voice **Georgi** (`31jwlwrRwpOA5yGuVAby`, native Bulgarian). Audio is generated through the user's Claude ElevenLabs connector and saved into the project as MP3 files. |
| Captions | Word timings estimated from the real audio duration, weighted by syllable count (`app/timing.py`). Swap to ElevenLabs' `/with-timestamps` alignment if the app ever calls the API directly. |
| Animation | Background motion presets per scene. The card is **static by design**; only captions move. |
| Content | A **deck** of false friends in `content/false_friends.json`, auto-assembled into scenes. |
| Backend | **FastAPI + uvicorn**, Python 3.12. |
| Frontend | Vanilla JS + plain CSS. No React, no build step, no npm, no CDN. |
| State | **One `project.json`** per project on disk. No database. |
| Trigger | `run.bat` → starts server → opens browser at `127.0.0.1:8000`. |

---

## 4. The rendering model — read this twice

This is the heart of the project. Get it right and everything else is easy.

### 4.1 The composition page is a pure function of time

`web/player/player.html` renders a project at **one specific timestamp**. It
exposes exactly one global function:

```js
window.seek(t)   // t = seconds, float. Renders the composition at time t.
                 // Returns a Promise that resolves when the DOM is settled.
```

**This must be deterministic.** Given the same project and the same `t`, it must
produce pixel-identical output, every time, forever. This is non-negotiable and
drives several hard rules:

- **No CSS animations or transitions. No `requestAnimationFrame` loops.**
  All motion is computed manually: `seek(t)` calculates each element's transform
  and opacity from `t` and applies them as inline styles.
- **No `Date.now()`, no `Math.random()`** anywhere in the player. Seeds and
  timing come from the project data only.
- **No lazy loading.** Every image must be fully decoded before any frame is
  captured. Expose `window.ready` — a Promise resolving once all assets have
  loaded and decoded (`img.decode()`).
- Audio is **not** played by the player. Audio is muxed in by ffmpeg at the end.
  The player is purely visual.

Playback in the studio preview is then just a `setInterval`/rAF loop calling
`seek(t)` with wall-clock time. Export is the same function called with
`frame / fps`. **One renderer, two drivers.**

### 4.2 The export pipeline

```
Playwright launches Chromium
  → page.set_viewport_size(1080, 1920), device_scale_factor=1
  → load player.html?project=<id>&export=1
  → await window.ready
  → for frame in range(total_frames):
        await page.evaluate(f"window.seek({frame / fps})")
        png = await page.screenshot(type="png")
        write png to ffmpeg stdin
  → close ffmpeg stdin, wait
```

ffmpeg reads PNGs from stdin and muxes the audio:

```
ffmpeg -y -f image2pipe -framerate 30 -i -
       -i mixed_audio.m4a
       -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p
       -c:a aac -b:a 192k -shortest -movflags +faststart out.mp4
```

Notes that will save hours:

- `-pix_fmt yuv420p` and even dimensions are **mandatory** or phones will not
  play the file. 1080×1920 is already even.
- Write PNG bytes to `proc.stdin` and handle `BrokenPipeError` by reading
  ffmpeg's stderr and reporting the real error. A broken pipe almost always
  means ffmpeg rejected the first frame — surface its message, never a bare
  traceback.
- Screenshot with `type="png"` (lossless). JPEG here would soften every frame
  before x264 ever sees it.
- Roughly 900 frames for a 30 s video. Expect 1–3 minutes. **Report progress
  per frame over SSE** so the UI has a real progress bar.
- Build the audio track separately first (see 6.5), then mux once. Do not try
  to stream audio and video into the same pass.

### 4.3 Audio is assembled independently

Voice-over clips are placed on a timeline with ffmpeg `adelay` + `amix`, plus an
optional music bed at low volume. The result is a single `mixed_audio.m4a` whose
length defines the video's length. Visuals are seeked to match. **Audio timing
is the source of truth; the visual timeline follows it.**

---

## 5. The data model

A project lives at `projects/<project_id>/` with `project.json` plus media.

```json
{
  "id": "my-first-video",
  "created_at": "2026-09-08T11:00:00Z",
  "settings": {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "checkpoint": "ponyDiffusionV6XL.safetensors",
    "negative_prompt": "blurry, watermark, text, deformed",
    "voice_id": "...",
    "voice_model": "eleven_multilingual_v2",
    "caption_style": "karaoke",
    "theme": "bold-white"
  },
  "scenes": [
    {
      "id": "sc_01",
      "start": 0.0,
      "duration": 3.1,
      "transition": "crossfade",
      "image": {
        "prompt": "a lone wolf on a snowy ridge at dawn, cinematic",
        "seed": 123456,
        "asset": "assets/sc_01_img_a1b2c3.png",
        "hash": "a1b2c3",
        "status": "ready",
        "locked": false,
        "motion": { "type": "zoom_in", "amount": 1.12 }
      },
      "voice": {
        "text": "Вълкът не се страхува от зимата.",
        "asset": "assets/sc_01_vo_d4e5f6.mp3",
        "words": [{ "word": "Вълкът", "start": 0.0, "end": 0.42 }],
        "duration": 2.8,
        "hash": "d4e5f6",
        "status": "ready",
        "locked": false
      },
      "overlay": {
        "text": "ЗИМА",
        "position": "top",
        "font_size": 96,
        "animation": "fade_up"
      }
    }
  ],
  "music": { "asset": null, "volume": 0.18 },
  "output": "output/my-first-video.mp4"
}
```

### 5.1 The caching rule

Every generated asset carries a **`hash`**: a short SHA-256 of the exact inputs
that produced it.

- Image hash inputs: `prompt + seed + checkpoint + negative_prompt + width + height + steps + cfg`
- Voice hash inputs: `text + voice_id + voice_model + voice_settings`

Before generating, compute the hash. **If a file for that hash exists, reuse it
and do no work.** This is what makes per-asset re-rolling cheap.

`locked: true` means **never regenerate, even if the hash changed** — the user
sets this on a take they love.

Note that **only images and audio are cached.** Because rendering is just DOM
manipulation, text and animation changes are free and instant — there is
nothing to invalidate. This is a major simplification over an ffmpeg-composited
design.

### 5.2 Timing

`voice.duration` comes from `ffprobe` on the MP3. Scene duration =
`voice.duration + 0.3s` tail (configurable), or 3.0 s if the scene has no voice.
`scene.start` is the running sum of prior durations and is **always recomputed
by the backend** — never trusted from the client.

---

## 6. Component specifications

### 6.1 Directory layout

```
video-gen-ai/
├── CLAUDE.md              ← this file
├── README.md
├── run.bat                ← the one click
├── requirements.txt
├── .env.example           ← ELEVENLABS_API_KEY=
├── .env                   ← gitignored
├── .gitignore
├── config.yaml
├── app/
│   ├── main.py            ← FastAPI app + routes
│   ├── models.py          ← pydantic models mirroring section 5
│   ├── store.py           ← load/save project.json, hashing, cache
│   ├── comfy.py           ← ComfyUI client
│   ├── tts.py             ← ElevenLabs client
│   ├── audio.py           ← builds mixed_audio.m4a
│   ├── export.py          ← Playwright + ffmpeg pipeline
│   └── jobs.py            ← serial task queue + SSE events
├── web/
│   ├── studio/            ← the editing UI
│   │   ├── index.html
│   │   ├── studio.js
│   │   └── studio.css
│   └── player/            ← the composition renderer
│       ├── player.html
│       ├── player.js      ← window.seek(t), window.ready
│       ├── scene.css      ← layout + typography of scenes
│       └── fonts/         ← bundled Cyrillic-capable font
├── workflows/
│   └── txt2img_sdxl.json  ← ComfyUI API-format workflow
├── projects/              ← gitignored
└── output/                ← gitignored
```

### 6.2 `player/` — the composition renderer

The player fetches `project.json`, builds the DOM once, then only mutates
inline styles on `seek(t)`.

Structure per scene:

```html
<div class="scene" data-id="sc_01">
  <div class="bg"><img src="..."></div>   <!-- transform: scale/translate -->
  <div class="overlay-text">ЗИМА</div>    <!-- opacity + translateY -->
</div>
<div class="captions"><!-- current caption line, word spans --></div>
```

`seek(t)` logic:

1. Find the active scene where `start <= t < start + duration`.
2. Set every other scene's `display:none` — except during a transition, where
   both the outgoing and incoming scenes are visible with computed opacities.
3. Compute local time `lt = t - scene.start`, and progress `p = lt / duration`.
4. Apply the image motion transform from `p` (see 6.3).
5. Apply the overlay text animation from `lt`.
6. Render the caption: find the word whose `[start, end)` contains `t` **in
   global time**, show its surrounding chunk, and mark the active word.

**Fonts:** bundle a Cyrillic-capable variable font (e.g. Inter or Montserrat)
in `player/fonts/` and load it with `@font-face`. Do **not** rely on system
fonts — many lack Cyrillic glyphs and will render empty boxes. Before the first
export frame, `await document.fonts.ready`.

**Caption styling** is the standard Shorts look: heavy weight, white fill, thick
dark outline via `-webkit-text-stroke` plus a `text-shadow` fallback, positioned
in the lower third. In `karaoke` style the active word gets an accent colour and
a slight scale-up; in `simple` style a 3–5 word chunk appears as a block.

### 6.3 Animation presets

All motion is a pure function of progress `p` (0→1), computed in JS. Use an
ease curve (`easeInOutCubic`) rather than linear — linear pans look mechanical.

**Image motion** (`image.motion.type`):

| Preset | Behaviour |
|---|---|
| `none` | static |
| `zoom_in` | scale 1.0 → `amount` (default 1.12) |
| `zoom_out` | scale `amount` → 1.0 |
| `pan_left` / `pan_right` | scale slightly over 1, translateX across |
| `pan_up` / `pan_down` | same on Y |

The image always uses `object-fit: cover` at slightly over 100% so panning never
reveals an edge.

**Overlay text** (`overlay.animation`): `none`, `fade_up` (opacity 0→1 +
translateY 30px→0 over the first 0.4 s), `pop` (scale 0.8→1 with a slight
overshoot), `slide_in` (translateX). All complete early in the scene and hold.

**Transitions** (`scene.transition`): `cut` (instant) or `crossfade` (0.4 s
overlap; during it, both scenes render with complementary opacities — the
outgoing scene's motion continues rather than freezing).

Keep this table in one JS object so adding a preset is a one-line change.

### 6.4 `tts.py` — ElevenLabs

- Endpoint: `POST /v1/text-to-speech/{voice_id}/with-timestamps`.
  **Use the `with-timestamps` variant** — it returns audio *and* character-level
  alignment, which is what makes word-accurate captions possible without Whisper.
- Model: `eleven_multilingual_v2`; Bulgarian is supported.
- Response has base64 `audio_base64` and `alignment` with `characters`,
  `character_start_times_seconds`, `character_end_times_seconds`.
- **Collapse characters into words**: split on whitespace, take the first
  character's start and the last character's end per word. Work in Python `str`
  (unicode), never bytes — Cyrillic is multi-byte and will corrupt otherwise.
- Save MP3 to assets; save the word list into `project.json`; get duration via
  `ffprobe` rather than trusting the last alignment timestamp.
- A missing or invalid API key must produce a clear UI error, not a stack trace.
- `GET /api/voices` proxies the voice list for the UI picker; cache per session.

### 6.5 `audio.py` — the audio timeline

Build one `mixed_audio.m4a` per render:

- Each scene's VO is delayed to its `scene.start` with `adelay`, then all are
  combined with `amix=inputs=N:normalize=0` (normalize=0 matters — otherwise
  ffmpeg quietens everything as inputs increase).
- Optional music bed: loop/trim to total duration, apply `volume`, and fade out
  over the last 1.5 s.
- Output AAC. Its duration is the video's duration.
- Cache on a hash of all VO hashes + music + volume.

### 6.6 `comfy.py` — ComfyUI client

1. `GET {url}/system_stats` → health check. If it fails, show a clear "ComfyUI
   is not running" banner. **Never crash the server because ComfyUI is down** —
   everything else must still work.
2. Open a websocket to `{ws_url}/ws?clientId={uuid4}` **before** queuing.
3. `POST {url}/prompt` with `{"prompt": <api_workflow>, "client_id": id}` →
   `{"prompt_id": ...}`.
4. Read websocket messages: `{"type":"progress","data":{"value":n,"max":m}}` is
   step progress — forward to the UI. `{"type":"executing","data":{"node":null,
   "prompt_id":X}}` means **done**.
5. `GET {url}/history/{prompt_id}` → find the SaveImage outputs → `GET
   {url}/view?filename=...&subfolder=...&type=output` for the PNG bytes.

**Workflows** live in `workflows/*.json` in **API format** — from ComfyUI's
"Save (API Format)" menu item, *not* the normal save. Patch fields **by node
`class_type`, never by hardcoded node ID**, so the user can edit their graph
without breaking us:

- `CheckpointLoaderSimple` → `ckpt_name`
- positive / negative `CLIPTextEncode` → `text`
- `KSampler` → `seed`, `steps`, `cfg`
- `EmptyLatentImage` → `width`, `height`

**Pony note:** Pony-family checkpoints need score tags in the positive prompt
(`score_9, score_8_up, score_7_up, ...`) and behave badly without them. Put this
in config as a per-checkpoint `prompt_prefix`, so switching between the Pony
model and the realism model needs no prompt rewriting.

**Resolution:** generate at 832×1216 (SDXL-native, ≈9:16) — the browser scales
it to 1080×1920. Generating at full 1080×1920 will OOM on 6 GB. Populate the
checkpoint dropdown from `GET /object_info`.

### 6.7 `jobs.py` — the queue

- **Single worker, strictly serial** — parallel ComfyUI jobs OOM on 6 GB.
- Job: `id`, `type` (`image` | `voice` | `audio` | `export`), `scene_id`,
  `status` (`queued`|`running`|`done`|`error`), `progress` 0–1, `message`.
- UI subscribes via **SSE at `GET /api/events`** — one-directional, simpler than
  websockets, reconnects for free.
- Export reports progress **per frame**. Jobs are cancellable, and one failure
  must not poison the queue.

### 6.8 API surface

```
GET    /api/projects                    list
POST   /api/projects                    create
GET    /api/projects/{id}               full project.json
PATCH  /api/projects/{id}               update settings / scene fields
POST   /api/projects/{id}/scenes        add scene
DELETE /api/projects/{id}/scenes/{sid}  remove scene
POST   /api/projects/{id}/scenes/reorder

POST   /api/projects/{id}/scenes/{sid}/image    regenerate just this image
POST   /api/projects/{id}/scenes/{sid}/voice    regenerate just this voice line
POST   /api/projects/{id}/export                render the MP4

GET    /api/events                      SSE job stream
GET    /api/health                      { comfy, elevenlabs, ffmpeg, playwright }
GET    /api/voices                      ElevenLabs voice list
GET    /media/{project}/{file}          serve assets to browser and to Playwright
```

Re-rolling an image with an unchanged prompt must use a **new random seed**
unless the user pinned one — "re-roll until I like it" is the primary use case.

### 6.9 `studio/` — the editing UI

Three regions:

1. **Left — settings:** checkpoint, voice, caption style, theme, music upload.
2. **Centre — live preview:** an `<iframe>` of `player.html` at 1080×1920,
   CSS-scaled to fit, with a **scrubber** and play/pause beneath it. Scrubbing
   calls `seek(t)` on the iframe directly — instant, no re-render, no server.
   During playback, also play the VO audio elements in the studio (outside the
   iframe) so the user hears timing; the player itself stays silent.
3. **Right — scene list:** a card per scene showing the image thumbnail
   (spinner + % while generating), editable image prompt, editable overlay text,
   editable VO text with an inline `<audio>` player and duration, plus motion
   and transition dropdowns. Four buttons: **Re-roll image**, **Redo voice**,
   **Lock**, **Delete**. Clicking a card seeks the preview to that scene.

Behaviour rules:

- Text, motion, and transition edits update the preview **immediately** — they
  cost nothing. Only image and voice edits mark an asset **stale** (dimmed, with
  a "changed — regenerate?" badge) and they never auto-generate: the user
  decides when to spend GPU time and API credits.
- Total duration is shown with a warning outside 20–30 s.
- Export button warns about stale assets and offers to regenerate them first.
- Health banner if ComfyUI is down or the key is missing.
- Autosave to `project.json`, debounced ~500 ms.

Dark, compact, readable CSS. No frameworks, no CDN — must work offline apart
from ElevenLabs calls.

### 6.10 `run.bat`

Check python → create `.venv` if missing → `pip install -r requirements.txt`
when it changed → `playwright install chromium` if missing → set
`PYTHONUTF8=1` → start uvicorn → open `http://127.0.0.1:8000`.
Idempotent, safe to double-click repeatedly.

---

## 7. Build phases — implement strictly in this order

**Phase 1 — the pipeline end to end.** `models.py`, `store.py`, a minimal
`player.html` that renders coloured rectangles with text and implements
`seek(t)`, and `export.py`. Hardcode a two-scene project. **Goal: `run.bat`
produces an MP4 that plays on a phone.** This proves the riskiest part —
Playwright determinism, PNG piping, pixel format — before anything else exists.
Do not proceed until that file plays.

**Phase 2 — voice and captions.** `tts.py`, word timings, `audio.py`, caption
rendering in the player. Verify Cyrillic renders as text, not boxes, in the
**exported MP4** (not just the browser). Durations now derive from real audio.

**Phase 3 — images and motion.** `comfy.py`, workflow patching, checkpoint
switching, seeds, plus the full motion/transition preset table in the player.

**Phase 4 — the studio.** `jobs.py`, SSE, the scrubber, per-asset regenerate,
lock, stale tracking, live progress.

**Phase 5 — polish.** Music bed, themes, project duplication, TikTok/Shorts
export presets.

After each phase: run end to end, confirm the MP4 plays, then commit.

---

## 8. Rules for Claude while building

- **The player must stay deterministic.** No CSS transitions, no rAF-driven
  animation, no `Date.now()`, no `Math.random()`. If a frame's appearance
  depends on anything but `t` and the project data, the export will flicker.
  This is the easiest way to break this project — guard it carefully.
- **Verify the exported MP4, not the preview.** Open the actual file and look at
  it. Font fallbacks, missing images, and timing bugs frequently appear only in
  the headless render.
- **Test every ffmpeg command by actually running it**, then inspect the output
  with `ffprobe`. Do not write a filter chain and assume it works.
- **Unicode:** every file read/write uses `encoding="utf-8"`. Windows defaults
  to cp1251/cp1252 and will mangle Bulgarian. Set `PYTHONUTF8=1` in `run.bat`.
- Serve assets to the player over **`http://127.0.0.1:8000/media/...`**, never
  `file://` — Playwright and fetch both behave badly with local file paths.
- Never call an external API in a loop without a delay and retry-with-backoff.
- Never delete a generated asset automatically. Cache eviction is manual.
- Keep dependencies minimal: `fastapi`, `uvicorn`, `pydantic`, `httpx`,
  `python-dotenv`, `pyyaml`, `websocket-client`, `playwright`. Nothing else
  without asking.
- If a decision here turns out wrong once real code runs, say so and propose the
  change — do not silently deviate.

---

## 9. Open items to confirm with the user

- Exact filenames of the Pony and photorealism checkpoints (read from
  ComfyUI `GET /object_info` and offer as a dropdown).
- Preferred ElevenLabs voice for Bulgarian — pick in the UI once `/api/voices`
  works.
- Whether scenes are written by hand or generated from a topic line by an LLM.
  A possible Phase 6; the architecture supports it, since an LLM would simply
  populate `project.json`.
