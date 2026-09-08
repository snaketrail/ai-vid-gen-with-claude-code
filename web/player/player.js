/* The composition renderer.
 *
 * Exposes exactly two globals:
 *   window.ready    Promise, resolves once fonts and images are decoded
 *   window.seek(t)  renders the composition at time t (seconds)
 *
 * seek(t) MUST be a pure function of (project, t). Same inputs, same pixels,
 * forever. That is what lets the studio preview and the headless export share
 * one renderer. Therefore, in this file:
 *   - no CSS animations/transitions, no requestAnimationFrame-driven motion
 *   - no Date.now(), no Math.random()
 * See CLAUDE.md 4.1 and section 8.
 */

(() => {
  'use strict';

  const CROSSFADE = 0.4;

  const params = new URLSearchParams(location.search);
  const projectId = params.get('project');

  const stage = document.getElementById('stage');

  let project = null;
  /** @type {Map<string, {root: HTMLElement, bg: HTMLElement, overlay: HTMLElement}>} */
  const sceneEls = new Map();
  let captionsEl = null;

  // ---- easing ---------------------------------------------------------

  function easeInOutCubic(p) {
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  }

  function easeOutBack(p) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  }

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  // ---- motion presets -------------------------------------------------
  // Each returns a CSS transform string for image progress p in [0,1].
  // Adding a preset is a one-line change here (CLAUDE.md 6.3).

  const MOTION = {
    none:      () => 'scale(1.02)',
    zoom_in:   (p, a) => `scale(${1.0 + (a - 1.0) * p})`,
    zoom_out:  (p, a) => `scale(${a - (a - 1.0) * p})`,
    pan_left:  (p) => `scale(1.14) translateX(${(0.5 - p) * 5}%)`,
    pan_right: (p) => `scale(1.14) translateX(${(p - 0.5) * 5}%)`,
    pan_up:    (p) => `scale(1.14) translateY(${(0.5 - p) * 5}%)`,
    pan_down:  (p) => `scale(1.14) translateY(${(p - 0.5) * 5}%)`,
  };

  // Overlay text animations, as a function of local scene time (seconds).
  // All complete early and then hold, so most of a scene is static.
  const OVERLAY_ANIM = {
    none: () => ({ opacity: 1, transform: '' }),
    fade_up: (lt) => {
      const p = easeInOutCubic(clamp01(lt / 0.4));
      return { opacity: p, transform: `translateY(${(1 - p) * 30}px)` };
    },
    pop: (lt) => {
      const p = clamp01(lt / 0.45);
      const s = 0.8 + (easeOutBack(p) * 0.2);
      return { opacity: clamp01(lt / 0.2), transform: `scale(${s})` };
    },
    slide_in: (lt) => {
      const p = easeInOutCubic(clamp01(lt / 0.45));
      return { opacity: p, transform: `translateX(${(1 - p) * -60}px)` };
    },
  };

  // ---- build ----------------------------------------------------------

  function buildScene(scene) {
    const root = document.createElement('div');
    root.className = 'scene';
    root.dataset.id = scene.id;

    const bg = document.createElement('div');
    bg.className = 'bg';

    if (scene.image && scene.image.asset) {
      const img = document.createElement('img');
      img.src = `/media/${projectId}/${scene.image.asset}`;
      bg.appendChild(img);
    } else {
      // Phase 1 stand-in: a flat colour, so the pipeline can be proven
      // before ComfyUI exists.
      bg.classList.add('solid');
      bg.style.background = (scene.image && scene.image.placeholder_color) || '#2b3a55';
    }
    root.appendChild(bg);

    const overlay = document.createElement('div');
    overlay.className = `overlay-text pos-${(scene.overlay && scene.overlay.position) || 'top'}`;
    overlay.textContent = (scene.overlay && scene.overlay.text) || '';
    overlay.style.fontSize = `${(scene.overlay && scene.overlay.font_size) || 96}px`;
    root.appendChild(overlay);

    stage.appendChild(root);
    sceneEls.set(scene.id, { root, bg, overlay, scene });
  }

  function build() {
    stage.innerHTML = '';
    sceneEls.clear();
    for (const scene of project.scenes) buildScene(scene);

    captionsEl = document.createElement('div');
    captionsEl.id = 'captions';
    stage.appendChild(captionsEl);
  }

  // ---- captions -------------------------------------------------------

  /** All words across the project, in global time. */
  let allWords = [];

  function collectWords() {
    allWords = [];
    for (const scene of project.scenes) {
      const words = (scene.voice && scene.voice.words) || [];
      for (const w of words) {
        allWords.push({
          word: w.word,
          start: scene.start + w.start,
          end: scene.start + w.end,
          scene: scene.id,
        });
      }
    }
  }

  const CHUNK = 4; // words shown together

  function renderCaptions(t) {
    if (!allWords.length) {
      captionsEl.style.display = 'none';
      return;
    }
    let idx = -1;
    for (let i = 0; i < allWords.length; i++) {
      if (t >= allWords[i].start && t < allWords[i].end) { idx = i; break; }
    }
    if (idx === -1) {
      captionsEl.style.display = 'none';
      return;
    }
    const style = (project.settings && project.settings.caption_style) || 'karaoke';
    const sceneId = allWords[idx].scene;
    // Chunk within the current scene only, so captions never span a cut.
    const sceneWords = allWords.filter((w) => w.scene === sceneId);
    const localIdx = sceneWords.indexOf(allWords[idx]);
    const chunkStart = Math.floor(localIdx / CHUNK) * CHUNK;
    const chunk = sceneWords.slice(chunkStart, chunkStart + CHUNK);

    captionsEl.style.display = 'block';
    captionsEl.innerHTML = '';
    for (const w of chunk) {
      const span = document.createElement('span');
      span.className = 'w';
      span.textContent = w.word;
      if (style === 'karaoke' && w === allWords[idx]) {
        span.classList.add('active');
        span.style.transform = 'scale(1.06)';
      }
      captionsEl.appendChild(span);
    }
  }

  // ---- seek -----------------------------------------------------------

  /**
   * @param entry   scene DOM handles
   * @param lt      local scene time in seconds
   * @param opacity scene-level opacity (crossfade)
   * @param introAt time used to drive the overlay intro animation. During a
   *   crossfade the scene is already on screen before its own start time, so
   *   the intro must run on the transition's clock; passing it separately
   *   keeps that continuous across the boundary instead of restarting.
   */
  function applyScene(entry, lt, opacity, introAt) {
    const { root, bg, overlay, scene } = entry;
    root.style.display = 'block';
    root.style.opacity = String(opacity);

    const dur = scene.duration || 1;
    const p = easeInOutCubic(clamp01(lt / dur));
    const motion = (scene.image && scene.image.motion) || { type: 'zoom_in', amount: 1.12 };
    const fn = MOTION[motion.type] || MOTION.none;
    bg.style.transform = fn(p, motion.amount || 1.12);

    const animName = (scene.overlay && scene.overlay.animation) || 'none';
    const anim = (OVERLAY_ANIM[animName] || OVERLAY_ANIM.none)(
      introAt === undefined ? lt : introAt,
    );
    overlay.style.opacity = String(anim.opacity);
    // pos-center already uses translateY(-50%); compose rather than clobber it.
    const base = (scene.overlay && scene.overlay.position) === 'center'
      ? 'translateY(-50%) ' : '';
    overlay.style.transform = base + (anim.transform || '');
  }

  function seek(t) {
    if (!project) return Promise.resolve();

    for (const entry of sceneEls.values()) {
      entry.root.style.display = 'none';
    }

    const scenes = project.scenes;
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const end = s.start + s.duration;
      const isLast = i === scenes.length - 1;
      // Include the final frame of the last scene so the video does not end
      // on an empty stage.
      const inside = t >= s.start && (t < end || (isLast && t <= end));
      if (!inside) continue;

      const entry = sceneEls.get(s.id);
      const lt = t - s.start;
      const next = scenes[i + 1];

      if (next && next.transition === 'crossfade') {
        const fadeStart = end - CROSSFADE;
        if (t >= fadeStart) {
          const fp = easeInOutCubic(clamp01((t - fadeStart) / CROSSFADE));
          // Outgoing scene keeps animating while fading out.
          applyScene(entry, lt, 1 - fp);
          // The incoming scene overlaps backwards into the outgoing scene's
          // time, so `t - next.start` is negative through the whole fade.
          // Feeding that to the overlay animation would leave its text at
          // opacity 0 until after the transition finished — a bare background
          // mid-crossfade. Drive the intro on the transition clock instead
          // (0 at the start of the fade), which continues seamlessly into the
          // scene's own time once it stands alone.
          applyScene(sceneEls.get(next.id), t - next.start, fp, t - fadeStart);
          break;
        }
      }
      // If this scene faded in, its intro already began CROSSFADE seconds
      // before its start time. Continue that same clock so the animation does
      // not restart at the boundary.
      applyScene(entry, lt, 1, s.transition === 'crossfade' ? lt + CROSSFADE : lt);
      break;
    }

    renderCaptions(t);
    return Promise.resolve();
  }

  // ---- readiness ------------------------------------------------------
  // Nothing may be captured until fonts and images are fully decoded,
  // or frames will render with fallback fonts / blank images.

  async function waitForAssets() {
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) { /* non-fatal */ }
    }
    const imgs = Array.from(stage.querySelectorAll('img'));
    await Promise.all(imgs.map(async (img) => {
      try {
        if (img.decode) await img.decode();
        else if (!img.complete) {
          await new Promise((res) => {
            img.onload = res;
            img.onerror = res;
          });
        }
      } catch (e) { /* a broken image must not block the render */ }
    }));
  }

  async function init() {
    const res = await fetch(`/api/projects/${projectId}`);
    if (!res.ok) throw new Error(`Cannot load project ${projectId}`);
    project = await res.json();
    build();
    collectWords();
    await waitForAssets();
    await seek(0);
    document.body.dataset.ready = '1';
    return true;
  }

  window.seek = seek;
  window.ready = init();
  window.getProject = () => project;
  // Let the studio reload after edits without recreating the iframe.
  window.reload = async () => { await init(); };
})();
