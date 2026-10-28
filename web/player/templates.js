/* Slide templates for long-form lessons.
 *
 * A template is a function (data, ctx) -> { root, timeline }. It builds the
 * slide's DOM once and returns the animation entries for it (see anim.js).
 * Timing inside a template is in scene-local seconds and depends only on the
 * data, never on layout or the clock, so seek(t) stays deterministic.
 *
 * Text fields accept one bit of markup: **word** renders as a highlight.
 *
 * Adding a template: write a function here, register it in TEMPLATES, add
 * its styles to lesson.css. Nothing else needs to change.
 */

(() => {
  'use strict';

  // ---- DOM helpers ----------------------------------------------------

  function h(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  const escapeHtml = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /** **x** -> highlighted span. Everything else is escaped. */
  const markup = (s) =>
    escapeHtml(s || '').replace(/\*\*(.+?)\*\*/g, '<span class="hl">$1</span>');

  function rich(tag, cls, parent, text) {
    const e = h(tag, cls, parent);
    e.innerHTML = markup(text);
    return e;
  }

  const num = (v, d) => (typeof v === 'number' ? v : d);

  /** Every slide starts with an optional heading that drops in first. */
  function heading(root, d, T, at = 0.15) {
    if (!d.heading) return;
    const el = rich('div', 'heading', root, d.heading);
    T.push({ el, preset: 'fade_down', at });
    const bar = h('div', 'heading-bar', root);
    T.push({ el: bar, preset: 'grow_x', at: at + 0.25 });
  }

  /** Highlights inside an element pulse once, after the text has landed. */
  function pulseHighlights(el, T, at) {
    el.querySelectorAll('.hl').forEach((hl, i) => {
      T.push({ el: hl, preset: 'pulse', at: at + i * 0.15 });
    });
  }

  /** The decorative sun. anim.js owns the glow's inline opacity, so its
   *  resting opacity is set on a wrapper instead. */
  function glow(root) {
    return h('div', 'glow', h('div', 'glow-wrap', root));
  }

  // ---- templates ------------------------------------------------------

  /** The lesson's opening card. */
  function title(d) {
    const T = [];
    const root = h('div', 't-title');
    T.push({ el: glow(root), preset: 'zoom', at: 0, dur: 1.4 });
    if (d.kicker) T.push({ el: h('div', 'kicker', root, d.kicker), preset: 'fade_down', at: 0.3 });
    T.push({ el: rich('div', 't-title-main', root, d.title), preset: 'wipe', at: 0.6, dur: 0.9 });
    T.push({ el: h('div', 't-title-bar', root), preset: 'grow_x', at: 1.3 });
    if (d.subtitle) T.push({ el: rich('div', 't-title-sub', root, d.subtitle), preset: 'fade_up', at: 1.6 });
    if (d.tags && d.tags.length) {
      const row = h('div', 't-title-tags', root);
      d.tags.forEach((tag, i) => {
        T.push({ el: h('div', 'tag', row, tag), preset: 'pop', at: 2.2 + i * 0.2 });
      });
    }
    return { root, timeline: T };
  }

  /** A chapter divider: big number, name, one-line summary. */
  function chapter(d) {
    const T = [];
    const root = h('div', 't-chapter');
    if (d.number) T.push({ el: h('div', 't-chapter-num', root, d.number), preset: 'zoom', at: 0.1, dur: 0.9 });
    const col = h('div', 't-chapter-col', root);
    T.push({ el: h('div', 't-chapter-line', col), preset: 'grow_x', at: 0.5 });
    T.push({ el: rich('div', 't-chapter-title', col, d.title), preset: 'slide_right', at: 0.7 });
    if (d.subtitle) T.push({ el: rich('div', 't-chapter-sub', col, d.subtitle), preset: 'fade_up', at: 1.2 });
    return { root, timeline: T };
  }

  /** A heading and a list that builds one item at a time. */
  function bullets(d) {
    const T = [];
    const root = h('div', 't-bullets');
    heading(root, d, T);
    const list = h('div', 'list', root);
    const start = num(d.start, 0.9), gap = num(d.gap, 0.9);
    (d.items || []).forEach((it, i) => {
      const item = typeof it === 'string' ? { text: it } : it;
      const at = start + i * gap;
      const row = h('div', 'row', list);
      T.push({ el: h('div', 'dot', row), preset: 'pop', at });
      const col = h('div', 'col', row);
      const text = rich('div', 'text', col, item.text);
      T.push({ el: text, preset: 'slide_left', at: at + 0.1 });
      if (item.sub) T.push({ el: rich('div', 'sub', col, item.sub), preset: 'fade', at: at + 0.45 });
      pulseHighlights(text, T, at + 0.6);
    });
    return { root, timeline: T };
  }

  /** One word, big: pronunciation, translation, meanings, one example. */
  function vocab(d) {
    const T = [];
    const root = h('div', 't-vocab');
    const left = h('div', 'left', root);
    T.push({ el: h('div', 'word', left, d.word), preset: 'pop', at: 0.3, dur: 0.6 });
    if (d.ipa) T.push({ el: h('div', 'ipa', left, d.ipa), preset: 'fade', at: 0.9 });
    T.push({ el: h('div', 'divider', root), preset: 'grow_y', at: 0.6 });
    const right = h('div', 'right', root);
    if (d.translation) {
      const tr = h('div', 'translation', right);
      h('span', 'lang', tr, 'BG');
      h('span', null, tr, d.translation);
      T.push({ el: tr, preset: 'slide_left', at: 1.2 });
    }
    if (d.meanings && d.meanings.length) {
      const chips = h('div', 'chips', right);
      d.meanings.forEach((m, i) => {
        T.push({ el: h('div', 'chip', chips, m), preset: 'pop', at: 1.8 + i * 0.25 });
      });
    }
    if (d.example) {
      const ex = rich('div', 'example', right, d.example);
      T.push({ el: ex, preset: 'fade_up', at: 2.8 });
      pulseHighlights(ex, T, 3.4);
    }
    if (d.example_bg) T.push({ el: rich('div', 'example-bg', right, d.example_bg), preset: 'fade', at: 3.3 });
    return { root, timeline: T };
  }

  /** A sentence pattern built from boxes: Subject + modal + verb. */
  function formula(d) {
    const T = [];
    const root = h('div', 't-formula');
    heading(root, d, T);
    const row = h('div', 'parts', root);
    const start = num(d.start, 0.8), gap = num(d.gap, 0.7);
    const parts = d.parts || [];
    parts.forEach((p, i) => {
      const at = start + i * gap;
      if (i > 0) T.push({ el: h('div', 'plus', row, '+'), preset: 'spin_in', at: at - 0.3 });
      const box = h('div', 'part' + (p.accent ? ' accent' : ''), row);
      h('div', 'label', box, p.text);
      if (p.hint) h('div', 'hint', box, p.hint);
      T.push({ el: box, preset: 'pop', at });
    });
    let at = start + parts.length * gap + 0.2;
    if (d.example) {
      const ex = rich('div', 'example', root, d.example);
      T.push({ el: ex, preset: 'fade_up', at });
      pulseHighlights(ex, T, at + 0.6);
      at += 0.9;
    }
    if (d.notes && d.notes.length) {
      const notes = h('div', 'notes', root);
      d.notes.forEach((n, i) => {
        T.push({ el: rich('div', 'note', notes, n), preset: 'pop', at: at + i * 0.5 });
      });
    }
    return { root, timeline: T };
  }

  /** English sentences with highlighted keywords and a Bulgarian line under each. */
  function examples(d) {
    const T = [];
    const root = h('div', 't-examples');
    heading(root, d, T);
    const list = h('div', 'list', root);
    const start = num(d.start, 0.9), gap = num(d.gap, 2.2);
    (d.items || []).forEach((it, i) => {
      const at = start + i * gap;
      const row = h('div', 'ex', list);
      T.push({ el: h('div', 'idx', row, String(i + 1)), preset: 'pop', at });
      const col = h('div', 'col', row);
      const en = rich('div', 'en', col, it.en);
      T.push({ el: en, preset: 'slide_left', at: at + 0.1 });
      pulseHighlights(en, T, at + 0.7);
      if (it.bg) T.push({ el: rich('div', 'tr', col, it.bg), preset: 'fade_up', at: at + 0.8 });
    });
    return { root, timeline: T };
  }

  /** A grammar grid that fills in row by row. */
  function table(d) {
    const T = [];
    const root = h('div', 't-table');
    heading(root, d, T);
    const cols = (d.columns || []).length || ((d.rows || [])[0] || []).length;
    const grid = h('div', 'grid', root);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    (d.columns || []).forEach((c, i) => {
      T.push({ el: rich('div', 'th', grid, c), preset: 'fade_down', at: 0.6 + i * 0.12 });
    });
    const start = num(d.start, 1.2), gap = num(d.gap, 1.2);
    (d.rows || []).forEach((row, r) => {
      row.forEach((cell, c) => {
        const td = rich('div', 'td', grid, cell);
        T.push({ el: td, preset: 'wipe', at: start + r * gap + c * 0.3, dur: 0.5 });
      });
    });
    return { root, timeline: T };
  }

  /** Common mistakes: the wrong version is struck out, the right one slides in. */
  function compare(d) {
    const T = [];
    const root = h('div', 't-compare');
    heading(root, d, T);
    const list = h('div', 'list', root);
    const start = num(d.start, 0.9), gap = num(d.gap, 2.6);
    (d.pairs || []).forEach((p, i) => {
      const at = start + i * gap;
      const row = h('div', 'pair', list);
      const wrong = h('div', 'wrong', row);
      // The bundled font has no ✓/✗ glyphs, and a fallback font would differ
      // between machines, so the marks are × and a CSS-drawn tick.
      h('span', 'mark', wrong, '×');
      const wt = rich('span', 'txt', wrong, p.wrong);
      const strike = h('div', 'strike', wt);
      T.push({ el: wrong, preset: 'slide_right', at });
      T.push({ el: strike, preset: 'grow_x', at: at + 0.8, dur: 0.35 });
      T.push({ el: wrong, preset: 'shake', at: at + 0.8 });
      T.push({ el: wrong, cls: 'struck', at: at + 0.8 });
      const arrow = h('div', 'arrow', row, '→');
      T.push({ el: arrow, preset: 'fade', at: at + 1.2 });
      const right = h('div', 'right', row);
      h('span', 'mark tick', right);
      rich('span', 'txt', right, p.right);
      T.push({ el: right, preset: 'slide_left', at: at + 1.4 });
    });
    if (d.note) {
      const at = start + (d.pairs || []).length * gap;
      T.push({ el: rich('div', 'note', root, d.note), preset: 'fade_up', at });
    }
    return { root, timeline: T };
  }

  /** A short conversation as chat bubbles; the first speaker is on the left. */
  function dialogue(d) {
    const T = [];
    const root = h('div', 't-dialogue');
    heading(root, d, T);
    const list = h('div', 'list', root);
    const speakers = [];
    const start = num(d.start, 0.9), gap = num(d.gap, 2.0);
    (d.lines || []).forEach((ln, i) => {
      if (!speakers.includes(ln.who)) speakers.push(ln.who);
      const side = speakers.indexOf(ln.who) % 2 === 0 ? 'l' : 'r';
      const at = num(ln.at, start + i * gap);
      const row = h('div', `line ${side}`, list);
      T.push({ el: h('div', 'avatar', row, (ln.who || '?').slice(0, 1)), preset: 'pop', at });
      const col = h('div', 'col', row);
      const bubble = h('div', 'bubble', col);
      h('div', 'name', bubble, ln.who);
      const txt = rich('div', 'txt', bubble, ln.text);
      T.push({ el: bubble, preset: 'pop', at: at + 0.1 });
      pulseHighlights(txt, T, at + 0.6);
      if (ln.bg) T.push({ el: rich('div', 'tr', col, ln.bg), preset: 'fade', at: at + 0.6 });
    });
    return { root, timeline: T };
  }

  /**
   * Fill in the blank: question, options, a countdown, then the reveal.
   * data: question (with ___), options, answer (index), think (seconds).
   */
  function quiz(d) {
    const T = [];
    const root = h('div', 't-quiz');
    T.push({ el: h('div', 'badge', root, d.label || 'QUIZ'), preset: 'pop', at: 0.1 });

    const q = h('div', 'question', root);
    const [before, after] = String(d.question || '').split('___');
    q.insertAdjacentHTML('beforeend', markup(before));
    const blank = h('span', 'blank', q);
    const gapEl = h('span', 'gap', blank, '?');
    const ans = h('span', 'ans', blank, (d.options || [])[d.answer] || '');
    if (after != null) q.insertAdjacentHTML('beforeend', markup(after));
    T.push({ el: q, preset: 'fade_up', at: 0.4 });

    const opts = h('div', 'options', root);
    const optEls = (d.options || []).map((o, i) => {
      const card = h('div', 'opt', opts);
      h('span', 'letter', card, String.fromCharCode(65 + i));
      h('span', 'otext', card, o);
      T.push({ el: card, preset: 'pop', at: 1.1 + i * 0.25 });
      return card;
    });

    const think = num(d.think, 3);
    const cdStart = 1.1 + optEls.length * 0.25 + 0.4;
    const timer = h('div', 'timer', root);
    const fill = h('div', 'fill', timer);
    T.push({ el: timer, preset: 'fade', at: cdStart - 0.2, dur: 0.3 });
    T.push({ el: fill, from: { sx: 1 }, to: { sx: 0 }, at: cdStart, dur: think, ease: 'linear' });
    const count = h('div', 'count', root);
    for (let i = 0; i < Math.ceil(think); i++) {
      const n = h('div', 'n', count, String(Math.ceil(think) - i));
      T.push({ el: n, preset: 'pop', at: cdStart + i, dur: 0.35 });
      T.push({ el: n, preset: 'fade_out', at: cdStart + i + 0.65, dur: 0.3 });
    }

    const reveal = cdStart + think;
    T.push({ el: timer, preset: 'fade_out', at: reveal });
    optEls.forEach((card, i) => {
      if (i === d.answer) {
        T.push({ el: card, cls: 'correct', at: reveal });
        T.push({ el: card, preset: 'pulse', at: reveal });
      } else {
        T.push({ el: card, cls: 'dim', at: reveal });
      }
    });
    T.push({ el: gapEl, from: { opacity: 1 }, to: { opacity: 0 }, at: reveal, dur: 0.2 });
    T.push({ el: ans, preset: 'pop', at: reveal + 0.1 });
    if (d.explain) T.push({ el: rich('div', 'explain', root, d.explain), preset: 'fade_up', at: reveal + 0.6 });
    return { root, timeline: T };
  }

  /** Summary cards: one per thing learned. */
  function recap(d) {
    const T = [];
    const root = h('div', 't-recap');
    heading(root, d, T);
    const grid = h('div', 'cards', root);
    const start = num(d.start, 0.8), gap = num(d.gap, 0.6);
    (d.items || []).forEach((it, i) => {
      const card = h('div', 'rcard', grid);
      h('div', 'word', card, it.word);
      if (it.use) rich('div', 'use', card, it.use);
      if (it.example) rich('div', 'ex', card, it.example);
      T.push({ el: card, preset: 'pop', at: start + i * gap });
    });
    return { root, timeline: T };
  }

  /** The lesson's closing card. */
  function end(d) {
    const T = [];
    const root = h('div', 't-end');
    T.push({ el: glow(root), preset: 'zoom', at: 0, dur: 1.4 });
    T.push({ el: rich('div', 'big', root, d.title || 'Well done!'), preset: 'pop', at: 0.3, dur: 0.7 });
    if (d.subtitle) T.push({ el: rich('div', 'sub', root, d.subtitle), preset: 'fade_up', at: 1.0 });
    if (d.site) {
      const site = h('div', 'site', root, d.site);
      T.push({ el: site, preset: 'typewriter', at: 1.6 });
    }
    return { root, timeline: T };
  }

  window.Templates = {
    title, chapter, bullets, vocab, formula, examples, table, compare,
    dialogue, quiz, recap, end,
  };
})();
