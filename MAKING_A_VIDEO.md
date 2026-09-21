# Making a video — runbook for a Claude Code session

> Read this when the user says *"make a fw / fs / ff video"*.
> `CLAUDE.md` explains how the app is **built**. This file explains how to
> **operate** it to produce one finished MP4.
>
> Read `CLAUDE.md` too before changing any code. This runbook assumes the app
> already works and you are only driving it.

---

## 1. What the three prefixes mean

The user names videos by deck prefix. That prefix decides the `deck` parameter
and nothing else — all three decks produce the same scene shape.

| User says | Deck (`deck` param) | Content file | Intro card | What a scene teaches |
|---|---|---|---|---|
| **ff** | `false_friends` | `content/false_friends.json` | FALSE FRIENDS | An English word a Bulgarian misreads (`FABRIC` ≠ фабрика, = плат) |
| **fw** | `word_explanations` | `content/word_explanations.json` | ENGLISH WORDS | A useful English word, plainly defined (no trap) |
| **fs** | `synonyms` | `content/synonyms.json` | SYNONYMS | An upgrade for a basic word (`HAPPY` → delighted, thrilled) |

Project ids follow the prefix: `ff`, `ff2`…`ff6`, `fw1`…`fw7`, `fs1`, `fs2`
(as of 2026-09-18 — check `projects/` rather than trusting this line).
**Create the next free number in that series** (e.g. if `fw7` exists, make `fw8`).
Never overwrite an existing project — `assemble` wipes `scenes` in place.

Deck sizes as of 2026-09-18: false_friends **40** items, synonyms **15**,
word_explanations **121**.

---

## 2. The short path (use this unless told otherwise)

The app has a one-call endpoint that assembles scenes, generates images and
renders in a single job.

```bash
# 1. Start the server (MUST be the venv python — global python lacks uvicorn)
cd /c/Users/stefd/Documents/GitHub/video-gen-ai
PYTHONUTF8=1 .venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# 2. Confirm it is up
curl -s http://127.0.0.1:8000/api/health
# -> {"ffmpeg":true,"ffprobe":true,"comfy":true,"elevenlabs":false}

# 3. Assemble + images + render, in one job
curl -s -X POST http://127.0.0.1:8000/api/projects/fw4/make \
  -H "Content-Type: application/json" \
  -d '{"count":4,"intro":true,"deck":"word_explanations"}'
# -> {"job":"export_fw4"}

# 4. Poll until terminal
curl -s http://127.0.0.1:8000/api/jobs/export_fw4
```

`count` is the number of **word scenes**; the intro is extra. `count: 4` gives 5
scenes total and lands near 30 s. See §6 on length.

**This produces a silent video.** `/make` does not generate voice-over — it
renders whatever audio already exists. For a video with sound, do §3 first, or
use the full path in §4.

---

## 3. Voice-over — the step that is NOT automated

There is no `app/tts.py`. The app never calls ElevenLabs itself
(`/api/health` reports `elevenlabs:false` and that is expected and fine).
Voice-over is generated **by you, through the Claude ElevenLabs connector**,
then written into the project.

Settings, fixed — do not substitute:

- Voice: **Georgi**, `31jwlwrRwpOA5yGuVAby` (native Bulgarian)
- Model: `eleven_multilingual_v2`
- `generations_count: 1` — this is production audio, not a pick-a-take. Each
  extra take costs real money.

Confirm the voice id with `creative_list_voices` before using it. The connector
contract says a voice_id must come from that tool, never from memory — and this
file counts as memory.

### Procedure

1. Assemble the scenes first (§4 step 2) so `project.json` holds the VO text.
2. `creative_create_flow` once, then one `creative_generate_speech` per scene,
   all on that flow — the `vo` line from the deck, verbatim.
3. Poll `creative_get_flow_run_status` until `all_completed`.
4. Download each MP3 and wire it in. The signed URLs expire in **2 hours**.

For step 4, follow what `app/outro.py` does. The rules that matter:

- Filename: `assets/<scene_id>_vo_<hash>.mp3`, where hash is
  `store.short_hash(text, voice_id, voice_model, "default")` (CLAUDE.md §5.1).
- Duration from `app.timing.audio_duration` (ffprobe) — **never** the model's
  own `duration_secs`.
- Word timings from `app.timing.estimate_words(text, duration)`. Connector audio
  carries no alignment, so these are syllable-weighted estimates.
- Set `voice.status = "ready"`, fill `settings.voice_id` / `voice_model`.
- Save with `store.save(project)` — it recomputes the timeline itself.

A working script for exactly this lives in the transcript of the session that
made `fw3`. If you need to rebuild it, the shape is:

```python
h = store.short_hash(text, VOICE_ID, VOICE_MODEL, "default")
dest = store.assets_dir(pid) / f"{scene.id}_vo_{h}.mp3"
dest.write_bytes(urllib.request.urlopen(url).read())
dur = audio_duration(dest)
scene.voice.asset = f"assets/{dest.name}"
scene.voice.hash, scene.voice.duration = h, dur
scene.voice.words = estimate_words(text, dur)
scene.voice.status = "ready"
```

Run it with the **venv python** if it imports anything beyond stdlib.

---

## 4. The full path — video with sound

```bash
# 1. Server up (see §2 step 1)

# 2. Assemble scenes only — no render yet
curl -s -X POST http://127.0.0.1:8000/api/projects/fw4/assemble \
  -H "Content-Type: application/json" \
  -d '{"count":4,"intro":true,"deck":"word_explanations"}'

# 3. Read back the VO lines you must generate
cat projects/fw4/project.json   # scenes[].voice.text

# 4. Generate + wire the voice-over  →  §3

# 5. Generate images (ComfyUI must be running on :8188)
curl -s -X POST http://127.0.0.1:8000/api/projects/fw4/images
curl -s http://127.0.0.1:8000/api/jobs/images_fw4   # poll to "done" FIRST
#   ...or one scene only: POST /api/projects/fw4/scenes/<sid>/image

# 6. Render — only once step 5 reports done
curl -s -X POST http://127.0.0.1:8000/api/projects/fw4/export
curl -s http://127.0.0.1:8000/api/jobs/export_fw4   # poll to "done"
```

**`/export` does not generate images.** It renders whatever images already
exist, so calling it on a freshly assembled project silently produces a video
of flat placeholder colours — it does not warn you. Always run `/images` and
wait for it to finish before `/export`. (`/make` is the exception: it chains
both itself, but it does no voice-over, so it is only for silent videos.)

Expect ~880 frames for a 30 s video, roughly 6 frames/sec → **2–3 minutes**.
Poll on a 5 s interval; do not spawn a Monitor for this.

Output lands in `output/<project>-<YYYY-MM-DD-HHMM>.mp4`. Filenames are
timestamped, so a re-render never overwrites an earlier one.

---

## 5. Always verify the exported MP4 — never the preview

CLAUDE.md §8 requires this, and headless-only bugs are real (missing glyphs,
missing images, timing drift). After every render:

```bash
f=output/fw4-*.mp4
ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt,r_frame_rate \
        -of default=noprint_wrappers=1 "$f"
```

Must show: `1080×1920`, `h264`, **`pix_fmt=yuv420p`**, `30/1`, plus an `aac`
stream. Anything else and phones will refuse the file.

Then actually look at it — pull frames and Read them as images:

```bash
for t in 1.5 6 13 19 25 32; do
  ffmpeg -v error -y -ss $t -i "$f" -frames:v 1 -vf scale=360:-1 "$SCRATCH/frame_$t.png"
done
```

Check: Cyrillic renders as **glyphs, not boxes**; the karaoke active word is
accent-coloured; each scene has its background image; the `stefdim.online` outro
is on the end.

---

## 6. Length — the thing that goes wrong most often

Target is **20–30 s** (CLAUDE.md §1). Two traps:

- **The outro is not in the body total.** It is a cached clip concatenated on,
  worth **~4.8 s**. `project.total_duration()` does not include it. Budget the
  body at **≤ 25 s** so the final file lands under 30.
- Scene duration is driven by real audio length, so it is only known after §3.

Check before rendering:

```bash
PYTHONUTF8=1 .venv/Scripts/python.exe -c "
from app import store, outro
p = store.load('fw4')
body = sum(s.duration for s in p.scenes)
print(f'body {body:.2f}s + outro {outro.duration():.2f}s = {body+outro.duration():.2f}s')
"
```

Over 30 s? Re-roll the longest VO lines with tighter wording, or drop to
`count: 3`. Re-rolling one line leaves the others cached and costs nothing —
that is the whole point of the per-asset hash.

`fw3` shipped at 34.29 s because this was checked only after rendering. Don't
repeat that.

---

## 7. Avoiding repeated words

**This is handled for you.** Both `/assemble` and `/make` call
`assemble.deck_ids_everywhere()`, which collects the deck ids used by *every*
project on disk and excludes them from the pick. A fresh `fw8` will not repeat
a word from `fw1`. You do not need to check by hand.

To see what is left in a deck:

```bash
PYTHONUTF8=1 python -c "
import json,glob
for name in ('false_friends','synonyms','word_explanations'):
    d=json.load(open(f'content/{name}.json',encoding='utf-8'))
    items = d if isinstance(d,list) else d.get('items',d)
    ids=[it['id'] for it in items]
    used={s['id'].replace('sc_','',1)
          for p in glob.glob('projects/*/project.json')
          for s in json.load(open(p,encoding='utf-8'))['scenes']}
    free=[i for i in ids if i not in used]
    print(f'{name}: {len(ids)} items, {len(ids)-len(free)} used, {len(free)} free')
"
```

Free as of 2026-09-18: **word_explanations 92**, **false_friends 19**,
**synonyms 6**. Plenty of room in fw; synonyms is the one that will run out
first. When a deck does run dry, add fresh items to its JSON in the same field
shape as the existing entries, and keep image prompts to objects/places, never
people (the model is weak at hands).

---

## 8. Gotchas that cost time

- **Use `.venv/Scripts/python.exe`**, not global `python`. Global lacks uvicorn
  and playwright. Global is fine for stdlib-only scripts.
- **`PYTHONUTF8=1` on every Python invocation.** Windows defaults to cp1251 and
  will mangle Bulgarian.
- **Do not start the server if it is already running** — check `/api/health`
  first. Two uvicorns on :8000 fail confusingly. Stop any server you started.
- **ComfyUI is separate** and the user launches it. If `comfy:false`, images
  fall back to flat placeholder colours and the video still renders — say so
  rather than silently shipping colour blocks.
- **Queue ComfyUI jobs serially.** 6 GB VRAM OOMs on parallel generations.
- **Never delete generated assets.** Cache eviction is manual (CLAUDE.md §8).
- Caption chunks can break mid-phrase — timings are estimates, not true
  alignment. Cosmetic; mention it, don't "fix" it by hand-editing timings.

---

## 9. When done, report

State plainly: output path, duration (body + outro), scene count and which deck
items were used, plus the ffprobe line proving format. Flag length overruns and
any scene that fell back to a placeholder colour. If the user wants captions for
posting, they may ask for TikTok/YouTube copy next — Bulgarian-language hashtags
carry the most value, with English ones for reach.
