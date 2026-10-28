# Long-form lessons — plan

Goal: make a whole **~40-minute English lesson** with this app, using animated
HTML compositions (in the spirit of HeyGen's HyperFrames) instead of relying on
ComfyUI stills.

Status: **Phases A, B, D and the first milestone are done** (see "Progress"
below). The Shorts pipeline is unchanged and keeps working; lessons are a
second format beside it (CLAUDE.md section 10).

---

## Why no rewrite is needed

The app is already built the way HyperFrames works: the video is a web page,
`window.seek(t)` renders any frame deterministically, and Playwright
screenshots frames into ffmpeg. What is missing is:

1. **An animation system.** Today the card is static and only the background
   moves.
2. **Scale.** The pipeline was built for 30 s. 40 min is ~72,000 frames.

| | Now | Needed |
|---|---|---|
| Visuals | ComfyUI image + static card + captions | Animated HTML layouts: text, shapes, SVG, tables, quizzes |
| Animation | 7 background motion presets | Per-element keyframed tracks |
| Length | ~900 frames | ~72,000 frames @ 30 fps |
| Structure | Flat list of scenes | Lesson → chapters → scenes → elements |
| Format | 1080×1920 vertical | 1920×1080 landscape (default), vertical still supported |

## Decisions so far

- **Voice-over: deferred.** For now, scene timing comes from explicit
  `duration` values in the lesson JSON, not from audio. The data model keeps a
  slot for narration so voice can be added later. Animations cued to
  voice words (Phase C) wait until then.
- **Tween engine: home-made**, in `player.js`. No GSAP, no new dependency.
  This fits CLAUDE.md's no-npm/no-CDN rule and keeps `seek(t)` pure.
- **Format:** 16:9 1920×1080 for lessons (confirmed). Width/height are
  project settings, so the 9:16 Shorts keep working.
- **First lesson:** modal verbs, A1 (confirmed).
- **Plan lives here** in the repo (`docs/LESSON_PLAN.md`).

## Phases

### A — Spec update
Add a long-form section to CLAUDE.md (data model, rules, render strategy).
Additive, not a replacement.

### B — Animation engine
- A scene is a stack of **elements**: `text`, `shape`, `svg`, `image`,
  `list`, `table`.
- Each element has keyframed **tracks**: opacity, x, y, scale, rotate,
  clip-path reveal, colour, typewriter reveal.
- Named presets (`fade_up`, `slide_in`, `pop`, `wipe`, `typewriter`, ...)
  sit in one JS table; a preset expands into keyframes. Adding one is a one-line
  change.
- Everything is declared in JSON (`"enter": "slide_up", "at": 1.2`), so a
  lesson can be authored, by hand or by an LLM, without touching code.
- **Determinism test:** render the same frame twice, compare hashes. A
  permanent check, run before every commit that touches the player.

### C — Voice sync (deferred with voice)
Animations can be cued to a word in the narration
(`"at": {"word": "magazine"}`) using the existing word timings. Audio stays
the source of truth once it exists.

### D — Template library
Reusable scene layouts with sensible default animations:

- title / chapter card
- vocab card
- false-friend comparison
- example sentence with a highlighted word
- fill-in-the-blank quiz with countdown and reveal
- two-person dialogue (chat bubbles)
- grammar table / timeline
- bullet recap
- kinetic typography

ComfyUI images remain available as an optional background or illustration
layer.

### E — 40-minute scale (riskiest part)
- **Render and cache per chapter**, like the outro is cached. Editing
  chapter 3 re-renders only chapter 3. The final video is a concat.
- **Static-frame reuse.** Lessons have many still holds. Because `seek(t)` is
  deterministic, the player can report when nothing on screen is animating,
  and the exporter reuses the previous PNG instead of taking a new screenshot.
- **Parallel Chromium workers**, one per chapter. This is CPU-bound only; no
  VRAM is involved.
- Keep only the DOM for scenes near the playhead, so the page stays light.
- Target: full 40-min render in under ~1 h; one chapter in a few minutes.

### F — Lesson authoring
- A lesson JSON format: topic, level, chapters, and per scene a template plus
  its content and duration.
- Claude drafts the whole lesson into that format; the user edits it in the
  studio.

### G — Studio for long-form
Chapter outline sidebar, timeline with chapter markers, jump-to-chapter, and
a render button per chapter.

### H — Polish
YouTube chapter timestamps, thumbnail, and **cutting Shorts out of a
lesson**: the same templates re-laid out at 9:16.

## First milestone

A **2-minute mini-lesson**: one chapter, ~4 templates, animated, exported to
MP4. Measuring its render time tells us if the 40-minute target holds before
building the rest.

## Where rendering can run

- **Locally (Windows laptop):** the primary path, as today. Needed for
  ComfyUI (GPU) and the studio.
- **Claude Code cloud session:** the container has Chromium, Playwright and
  ffmpeg (4 CPUs, 15 GB RAM, no GPU). Development, determinism tests and
  test renders of the animated HTML templates can run there. ComfyUI cannot.
  The container is ephemeral, and rendered MP4s should not be committed to git.

## Progress

**Done**
- A: CLAUDE.md section 10 documents the long-form format.
- B: `web/player/anim.js` tween engine. Determinism is enforced by
  `python -m app.check_determinism` (two browsers, one in reverse order, pixel
  comparison). Getting it to pass needed `--disable-partial-raster`, removing
  transforms at rest, and whole-pixel translations.
- D: 12 templates in `web/player/templates.js`: title, chapter, bullets,
  vocab, formula, examples, table, compare, dialogue, quiz, recap, end.
- Part of E: frame reuse. `seek(t)` returns a signature and the exporter skips
  screenshots for unchanged frames; `--verify-dedupe` proves it is lossless.
- Part of F: lesson files in `content/lessons/`, built by `app/lesson.py`.
- `web/player/preview.html?project=<id>`: scrub and play in the browser.

**First milestone: `content/lessons/modal_verbs_a1.json`**
- A1 modal verbs (can / must / should): 6 chapters, 20 slides, 155 s.
- Render in the cloud container (4 CPUs, no GPU): **385 s for 155 s of
  video, about 2.5× real time**. 2207 of 4650 frames reused.
- Determinism check: 665/665 sampled frames identical, 0 wrong reuses.

**What that means for 40 minutes.** At 2.5× real time, one worker would take
about 100 min. That is too slow for the < 1 h target, so the rest of Phase E
matters:
- per-chapter rendering on parallel Chromium workers (the obvious next win);
- per-chapter caching, so an edit re-renders one chapter, not the lesson;
- longer holds in real lessons (with voice-over, slides sit still while the
  narrator talks) will raise the reuse rate above this dense test's 47%.

**Next**
1. Phase E: chapter-parallel rendering + per-chapter cache, then measure.
2. Phase G: lessons in the studio (it is still hard-wired to the Shorts
   project `ff` and a 9:16 preview).
3. A lighter font weight: the bundled font is Segoe UI Black only. Bundling
   a variable Cyrillic font (Inter or Montserrat, OFL) would give body text
   proper weights.
4. Voice-over (Phase C), when wanted.

## Open questions

- Is the slide pacing right without narration, or should slides hold longer?
