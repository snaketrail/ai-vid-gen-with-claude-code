/* The tween engine for animated slides.
 *
 * A timeline is a flat list of entries, each targeting one DOM element:
 *
 *   { el, preset: 'fade_up', at: 1.2 }              a named preset
 *   { el, from: {x: -80}, to: {x: 0}, at, dur, ease } a raw tween
 *   { el, cls: 'correct', at: 6.0, until: 9.0 }       a class switched on at
 *                                                     `at` (off at `until`)
 *
 * Anim.apply(compiled, lt) sets every element's inline style from the
 * scene-local time `lt` alone. Nothing is stateful: the same lt always gives
 * the same styles, so seeking backwards, forwards or at random is exact.
 * That is the whole determinism contract (CLAUDE.md 4.1), so in this file:
 *   - no CSS animations/transitions, no requestAnimationFrame
 *   - no Date.now(), no Math.random()
 *   - no layout reads (getBoundingClientRect etc.): offsets are constants
 */

(() => {
  'use strict';

  // ---- easing ---------------------------------------------------------

  const EASE = {
    linear: (p) => p,
    inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
    outQuint: (p) => 1 - Math.pow(1 - p, 5),
    inCubic: (p) => p * p * p,
    // Overshoots slightly past 1 and settles: the "pop" feel.
    outBack: (p) => {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
    },
  };

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  // Values an element has when no tween touches a property.
  const DEFAULTS = {
    opacity: 1, x: 0, y: 0, scale: 1, sx: 1, sy: 1, rotate: 0,
    reveal: 1,  // clip-path wipe from the left, 0 = hidden, 1 = whole
    chars: 1,   // typewriter, fraction of characters shown
  };

  // ---- presets --------------------------------------------------------
  // Each returns one or more tweens, offsets relative to the entry's `at`.
  // Adding a preset is a one-line change here (CLAUDE.md 6.3).

  const PRESETS = {
    fade:        () => [{ from: { opacity: 0 }, to: { opacity: 1 }, dur: 0.5, ease: 'outCubic' }],
    fade_out:    () => [{ from: { opacity: 1 }, to: { opacity: 0 }, dur: 0.4, ease: 'inCubic' }],
    fade_up:     () => [{ from: { opacity: 0, y: 40 }, to: { opacity: 1, y: 0 }, dur: 0.6, ease: 'outCubic' }],
    fade_down:   () => [{ from: { opacity: 0, y: -40 }, to: { opacity: 1, y: 0 }, dur: 0.6, ease: 'outCubic' }],
    slide_left:  () => [{ from: { opacity: 0, x: 140 }, to: { opacity: 1, x: 0 }, dur: 0.6, ease: 'outQuint' }],
    slide_right: () => [{ from: { opacity: 0, x: -140 }, to: { opacity: 1, x: 0 }, dur: 0.6, ease: 'outQuint' }],
    pop:         () => [{ from: { opacity: 0, scale: 0.6 }, to: { opacity: 1, scale: 1 }, dur: 0.5, ease: 'outBack' }],
    zoom:        () => [{ from: { opacity: 0, scale: 1.35 }, to: { opacity: 1, scale: 1 }, dur: 0.7, ease: 'outCubic' }],
    wipe:        () => [{ from: { reveal: 0 }, to: { reveal: 1 }, dur: 0.7, ease: 'inOutCubic' }],
    grow_x:      () => [{ from: { sx: 0 }, to: { sx: 1 }, dur: 0.6, ease: 'inOutCubic' }],
    grow_y:      () => [{ from: { sy: 0 }, to: { sy: 1 }, dur: 0.6, ease: 'inOutCubic' }],
    spin_in:     () => [{ from: { opacity: 0, rotate: -90, scale: 0.4 }, to: { opacity: 1, rotate: 0, scale: 1 }, dur: 0.7, ease: 'outBack' }],
    pulse:       () => [
      { from: { scale: 1 }, to: { scale: 1.12 }, dur: 0.18, ease: 'outCubic' },
      { from: { scale: 1.12 }, to: { scale: 1 }, offset: 0.18, dur: 0.3, ease: 'inOutCubic' },
    ],
    shake:       () => [
      { from: { x: 0 }, to: { x: -14 }, dur: 0.06, ease: 'linear' },
      { from: { x: -14 }, to: { x: 14 }, offset: 0.06, dur: 0.12, ease: 'linear' },
      { from: { x: 14 }, to: { x: -8 }, offset: 0.18, dur: 0.1, ease: 'linear' },
      { from: { x: -8 }, to: { x: 0 }, offset: 0.28, dur: 0.1, ease: 'linear' },
    ],
    // Duration scales with text length so typing speed is constant.
    typewriter:  (el, o) => {
      const n = (el.dataset.full || el.textContent || '').length;
      return [{ from: { chars: 0 }, to: { chars: 1 }, dur: o.dur || Math.max(0.3, n * 0.035), ease: 'linear' }];
    },
  };

  // ---- compile --------------------------------------------------------

  /**
   * Turn timeline entries into per-element, per-property segment lists,
   * sorted by start time. Done once at build; apply() is then a lookup.
   */
  function compile(entries) {
    const byEl = new Map();
    const classes = [];

    const tracksFor = (el) => {
      if (!byEl.has(el)) byEl.set(el, {});
      return byEl.get(el);
    };

    for (const e of entries) {
      if (!e || !e.el) continue;
      const at = e.at || 0;

      if (e.cls) {
        classes.push({ el: e.el, cls: e.cls, at, until: e.until == null ? Infinity : e.until });
        continue;
      }

      let tweens;
      if (e.preset) {
        const fn = PRESETS[e.preset];
        if (!fn) throw new Error(`Unknown animation preset: ${e.preset}`);
        tweens = fn(e.el, e);
        // Entry-level overrides apply to single-tween presets.
        if (tweens.length === 1) {
          if (e.dur != null) tweens[0].dur = e.dur;
          if (e.ease) tweens[0].ease = e.ease;
        }
      } else {
        tweens = [{ from: e.from || {}, to: e.to || {}, dur: e.dur == null ? 0.5 : e.dur, ease: e.ease || 'outCubic' }];
      }

      const tracks = tracksFor(e.el);
      for (const tw of tweens) {
        const start = at + (tw.offset || 0);
        const dur = Math.max(0.0001, tw.dur);
        const ease = EASE[tw.ease] || EASE.outCubic;
        const props = new Set([...Object.keys(tw.from), ...Object.keys(tw.to)]);
        for (const prop of props) {
          if (!(prop in DEFAULTS)) throw new Error(`Unknown animated property: ${prop}`);
          (tracks[prop] = tracks[prop] || []).push({
            start, dur, ease, from: tw.from[prop], to: tw.to[prop],
          });
        }
      }
    }

    // Resolve missing from/to values against the previous segment, so a
    // tween only needs to name what it changes.
    for (const tracks of byEl.values()) {
      for (const prop of Object.keys(tracks)) {
        const segs = tracks[prop].sort((a, b) => a.start - b.start);
        let prev = DEFAULTS[prop];
        for (const s of segs) {
          if (s.from == null) s.from = prev;
          if (s.to == null) s.to = DEFAULTS[prop];
          prev = s.to;
        }
      }
    }
    for (const [el, tracks] of byEl) {
      if (tracks.chars && el.dataset.full == null) el.dataset.full = el.textContent;
    }

    return { byEl, classes };
  }

  // ---- apply ----------------------------------------------------------

  function valueAt(segs, lt) {
    if (lt < segs[0].start) return segs[0].from;
    let s = segs[0];
    for (let i = 1; i < segs.length && segs[i].start <= lt; i++) s = segs[i];
    const p = clamp01((lt - s.start) / s.dur);
    return s.from + (s.to - s.from) * s.ease(p);
  }

  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Round so tiny float noise can never change pixels or the signature.
  const r = (v) => Math.round(v * 1000) / 1000;

  /**
   * Set every animated element's styles for scene-local time lt. Returns a
   * signature string of everything that was set: equal signatures mean
   * identical pixels, which lets the exporter skip duplicate screenshots.
   */
  function apply(compiled, lt) {
    const sig = [];
    for (const [el, tracks] of compiled.byEl) {
      const v = {};
      for (const prop of Object.keys(DEFAULTS)) {
        v[prop] = tracks[prop] ? r(valueAt(tracks[prop], lt)) : DEFAULTS[prop];
      }
      // Whole pixels only: at a fractional offset Chromium's text placement
      // depends on what was drawn the frame before, so the same t could
      // give different pixels. At 30 fps the snapping is invisible.
      v.x = Math.round(v.x);
      v.y = Math.round(v.y);

      el.style.opacity = String(clamp01(v.opacity));
      const resting = v.x === 0 && v.y === 0 && v.rotate === 0 &&
        v.scale * v.sx === 1 && v.scale * v.sy === 1;
      // At rest the transform is removed, not set to an identity matrix:
      // Chromium keeps a transformed element's raster around, and text
      // that was just rotated or scaled would otherwise land on slightly
      // different pixels than text that never moved.
      el.style.transform = resting ? '' :
        `translate(${v.x}px, ${v.y}px) rotate(${v.rotate}deg) ` +
        `scale(${r(v.scale * v.sx)}, ${r(v.scale * v.sy)})`;
      el.style.clipPath = v.reveal < 1 ? `inset(-20% ${r((1 - clamp01(v.reveal)) * 100)}% -20% -20%)` : '';

      if (tracks.chars) {
        const full = el.dataset.full || '';
        const n = Math.round(clamp01(v.chars) * full.length);
        if (el.dataset.shown !== String(n)) {
          // The untyped rest stays in the layout, invisible, so text never
          // reflows as it is typed.
          el.innerHTML = escapeHtml(full.slice(0, n)) +
            `<span style="visibility:hidden">${escapeHtml(full.slice(n))}</span>`;
          el.dataset.shown = String(n);
        }
      }
      sig.push(`${v.opacity},${v.x},${v.y},${v.scale},${v.sx},${v.sy},${v.rotate},${v.reveal},${v.chars}`);
    }

    for (const c of compiled.classes) {
      const on = lt >= c.at && lt < c.until;
      c.el.classList.toggle(c.cls, on);
      sig.push(on ? '1' : '0');
    }
    return sig.join('|');
  }

  window.Anim = { EASE, PRESETS, compile, apply };
})();
