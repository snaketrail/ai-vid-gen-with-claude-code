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
  /** @type {Map<string, {root: HTMLElement, bg: HTMLElement, scene: object}>} */
  const sceneEls = new Map();
  let captionsEl = null;

  // ---- easing ---------------------------------------------------------

  function easeInOutCubic(p) {
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
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

  // ---- build ----------------------------------------------------------

  function buildScene(scene) {
    const root = document.createElement('div');
    root.className = 'scene';
    root.dataset.id = scene.id;

    const bg = document.createElement('div');
    bg.className = 'bg';

    const isOutro = scene.kind === 'outro';

    if (isOutro) {
      // The outro is a fixed brand mark: flat background, logo shown whole
      // (never cropped), no motion. Not a photo, so `cover` would be wrong.
      bg.classList.add('solid');
      bg.style.background = (scene.image && scene.image.placeholder_color) || '#0e1527';
    } else if (scene.image && scene.image.asset) {
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

    if (isOutro) {
      const wrap = document.createElement('div');
      wrap.className = 'outro';
      if (scene.image && scene.image.asset) {
        const logo = document.createElement('img');
        logo.className = 'outro-logo';
        logo.src = `/media/${projectId}/${scene.image.asset}`;
        wrap.appendChild(logo);
      }
      // The logo already carries the domain, so the text below is just the
      // call to action — repeating the URL would read as a mistake.
      const cta = document.createElement('div');
      cta.className = 'outro-cta';
      cta.textContent = 'Абонирайте се за повече видеа';
      wrap.appendChild(cta);
      root.appendChild(wrap);
      stage.appendChild(root);
      sceneEls.set(scene.id, { root, bg, scene });
      return;
    }

    // The false-friend card: static for the whole scene. Only the captions
    // move — deliberate, so the word stays readable while the VO plays.
    const card = document.createElement('div');
    card.className = 'card';
    const c = scene.card || {};
    if (c.word) {
      const w = document.createElement('div');
      w.className = 'card-word';
      w.textContent = c.word;
      card.appendChild(w);
    }
    if (c.looks_like) {
      const l = document.createElement('div');
      l.className = 'card-row card-trap';
      l.innerHTML = `<span class="tag">✗</span><span>${c.looks_like}</span>`;
      card.appendChild(l);
    }
    if (c.actually) {
      const a = document.createElement('div');
      a.className = 'card-row card-true';
      a.innerHTML = `<span class="tag">✓</span><span>${c.actually}</span>`;
      card.appendChild(a);
    }
    root.appendChild(card);

    stage.appendChild(root);
    sceneEls.set(scene.id, { root, bg, scene });
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
    // The outro shows its call to action as fixed layout text, so captions
    // would just duplicate it.
    const active = project.scenes.find(
      (s) => t >= s.start && t < s.start + s.duration,
    );
    if (active && active.kind === 'outro') {
      captionsEl.style.display = 'none';
      return;
    }
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
   * The card is static for the whole scene, so a scene's appearance depends
   * only on its own local time and its crossfade opacity. That removes the
   * intro-clock the animated overlay needed, and with it a class of
   * transition bugs.
   */
  function applyScene(entry, lt, opacity) {
    const { root, bg, scene } = entry;
    root.style.display = 'block';
    root.style.opacity = String(opacity);

    const dur = scene.duration || 1;
    const p = easeInOutCubic(clamp01(lt / dur));
    const motion = (scene.image && scene.image.motion) || { type: 'zoom_in', amount: 1.12 };
    const fn = MOTION[motion.type] || MOTION.none;
    bg.style.transform = fn(p, motion.amount || 1.12);
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
          // time, so its local time is negative here; the motion easing
          // clamps it, and the card is static, so this is well-defined.
          applyScene(sceneEls.get(next.id), t - next.start, fp);
          break;
        }
      }
      applyScene(entry, lt, 1);
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
