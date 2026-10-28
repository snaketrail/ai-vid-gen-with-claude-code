# Long-form lessons — plan

Goal: make a whole **~40-minute English lesson** with this app, using animated
HTML compositions (in the spirit of HeyGen's HyperFrames) instead of relying on
ComfyUI stills.

Status: **plan, agreed in outline. Not yet built.** CLAUDE.md is still the spec
for the existing Shorts pipeline. When Phase A lands, this plan gets folded
into it as a "long-form" section; Shorts keep working unchanged.

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
- **Format:** 16:9 1920×1080 by default for lessons. Width/height are already
  project settings, so vertical keeps working.
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

## Open questions

- Topic and level of the first lesson.
- Confirm 16:9 for lessons (assumed above).
