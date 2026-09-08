/* Studio UI. Phase 1: scene editing, scrubbing, export.
 *
 * Playback here is the second "driver" of the shared renderer: it calls the
 * same window.seek(t) inside the player iframe that the headless export calls.
 */

(() => {
  'use strict';

  const PROJECT = 'demo';

  const $ = (id) => document.getElementById(id);
  const iframe = $('player');
  const scrub = $('scrub');
  const timeLabel = $('timeLabel');
  const playBtn = $('playBtn');

  let project = null;
  let playing = false;
  let playStart = 0;      // wall clock ms at play start
  let playFrom = 0;       // timeline seconds at play start
  let saveTimer = null;

  const dur = () => {
    if (!project || !project.scenes.length) return 0;
    const last = project.scenes[project.scenes.length - 1];
    return last.start + last.duration;
  };

  const playerWin = () => iframe.contentWindow;

  async function seek(t) {
    const w = playerWin();
    if (w && typeof w.seek === 'function') await w.seek(t);
    timeLabel.textContent = `${t.toFixed(2)} / ${dur().toFixed(2)}`;
  }

  // ---- loading --------------------------------------------------------

  async function loadProject() {
    let res = await fetch(`/api/projects/${PROJECT}`);
    if (res.status === 404) {
      await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: PROJECT }),
      });
      res = await fetch(`/api/projects/${PROJECT}`);
    }
    project = await res.json();
  }

  function reloadPlayer() {
    return new Promise((resolve) => {
      iframe.onload = async () => {
        const w = playerWin();
        try { if (w.ready) await w.ready; } catch (e) { console.error(e); }
        await seek(Number(scrub.value) * dur());
        resolve();
      };
      iframe.src = `/player/player.html?project=${PROJECT}&t=${Date.now()}`;
    });
  }

  /** Push the edited project, then rebuild the preview. */
  function save({ rebuild = true } = {}) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const res = await fetch(`/api/projects/${PROJECT}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(project),
      });
      project = await res.json();
      renderSceneList();
      if (rebuild) await reloadPlayer();
    }, 400);
  }

  // ---- scene list -----------------------------------------------------

  const MOTIONS = ['none', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down'];
  const ANIMS = ['none', 'fade_up', 'pop', 'slide_in'];
  const TRANSITIONS = ['cut', 'crossfade'];

  function select(value, options, onChange) {
    const sel = document.createElement('select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      if (o === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  function labelled(text, el) {
    const wrap = document.createElement('div');
    const lab = document.createElement('label');
    lab.textContent = text;
    wrap.appendChild(lab);
    wrap.appendChild(el);
    return wrap;
  }

  function renderSceneList() {
    const list = $('sceneList');
    list.innerHTML = '';

    project.scenes.forEach((scene) => {
      const card = document.createElement('div');
      card.className = 'scene-card';

      const head = document.createElement('div');
      head.className = 'row head';
      const sid = document.createElement('span');
      sid.className = 'sid';
      sid.textContent = `${scene.id} · ${scene.start.toFixed(1)}s → ${(scene.start + scene.duration).toFixed(1)}s`;
      head.appendChild(sid);

      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        await fetch(`/api/projects/${PROJECT}/scenes/${scene.id}`, { method: 'DELETE' });
        await loadProject();
        renderSceneList();
        await reloadPlayer();
      });
      head.appendChild(del);
      card.appendChild(head);

      // Jump the preview to this scene.
      sid.style.cursor = 'pointer';
      sid.addEventListener('click', () => {
        const t = scene.start + 0.05;
        scrub.value = String(dur() ? t / dur() : 0);
        seek(t);
      });

      const overlay = document.createElement('textarea');
      overlay.value = scene.overlay.text;
      overlay.placeholder = 'Headline text';
      overlay.addEventListener('input', () => {
        scene.overlay.text = overlay.value;
        save();
      });
      card.appendChild(labelled('Overlay text', overlay));

      const vo = document.createElement('textarea');
      vo.value = scene.voice.text;
      vo.placeholder = 'Voice-over line (Phase 2)';
      vo.addEventListener('input', () => {
        scene.voice.text = vo.value;
        save();
      });
      card.appendChild(labelled('Voice-over', vo));

      const row = document.createElement('div');
      row.className = 'row';

      const colour = document.createElement('input');
      colour.type = 'color';
      colour.className = 'swatch';
      colour.value = scene.image.placeholder_color || '#2b3a55';
      colour.addEventListener('input', () => {
        scene.image.placeholder_color = colour.value;
        save();
      });
      row.appendChild(colour);

      row.appendChild(select(scene.image.motion.type, MOTIONS, (v) => {
        scene.image.motion.type = v; save();
      }));
      row.appendChild(select(scene.overlay.animation, ANIMS, (v) => {
        scene.overlay.animation = v; save();
      }));
      row.appendChild(select(scene.transition, TRANSITIONS, (v) => {
        scene.transition = v; save();
      }));
      card.appendChild(row);

      const secs = document.createElement('input');
      secs.type = 'text';
      secs.value = String(scene.duration);
      secs.addEventListener('change', () => {
        const v = parseFloat(secs.value);
        if (!isNaN(v) && v > 0) { scene.duration = v; save(); }
      });
      card.appendChild(labelled('Duration (s) — until voice exists', secs));

      list.appendChild(card);
    });
  }

  // ---- transport ------------------------------------------------------

  function tick() {
    if (!playing) return;
    const elapsed = (performance.now() - playStart) / 1000;
    let t = playFrom + elapsed;
    const total = dur();
    if (t >= total) { t = total; stop(); }
    scrub.value = String(total ? t / total : 0);
    seek(t);
    if (playing) requestAnimationFrame(tick);
  }

  function play() {
    if (!dur()) return;
    playing = true;
    playBtn.textContent = '❚❚';
    playFrom = Number(scrub.value) * dur();
    if (playFrom >= dur() - 0.01) playFrom = 0;
    playStart = performance.now();
    requestAnimationFrame(tick);
  }

  function stop() {
    playing = false;
    playBtn.textContent = '▶';
  }

  playBtn.addEventListener('click', () => (playing ? stop() : play()));
  scrub.addEventListener('input', () => {
    stop();
    seek(Number(scrub.value) * dur());
  });

  // ---- export ---------------------------------------------------------

  $('exportBtn').addEventListener('click', async () => {
    const btn = $('exportBtn');
    const status = $('exportStatus');
    btn.disabled = true;
    status.className = 'status';
    status.textContent = 'Starting…';

    const res = await fetch(`/api/projects/${PROJECT}/export`, { method: 'POST' });
    if (!res.ok) {
      status.className = 'status err';
      status.textContent = (await res.json()).detail || 'Failed to start';
      btn.disabled = false;
      return;
    }
    const { job } = await res.json();

    const poll = setInterval(async () => {
      const j = await (await fetch(`/api/jobs/${job}`)).json();
      status.textContent = `${j.message} (${Math.round((j.progress || 0) * 100)}%)`;
      if (j.status === 'done') {
        clearInterval(poll);
        status.className = 'status ok';
        status.textContent = j.message;
        const v = $('result');
        v.src = `/api/output/${PROJECT}?t=${Date.now()}`;
        v.style.display = 'block';
        btn.disabled = false;
      } else if (j.status === 'error') {
        clearInterval(poll);
        status.className = 'status err';
        status.textContent = j.message;
        btn.disabled = false;
      }
    }, 500);
  });

  $('addScene').addEventListener('click', async () => {
    await fetch(`/api/projects/${PROJECT}/scenes`, { method: 'POST' });
    await loadProject();
    renderSceneList();
    await reloadPlayer();
  });

  // ---- health ---------------------------------------------------------

  async function health() {
    const h = await (await fetch('/api/health')).json();
    const bits = [
      ['ffmpeg', h.ffmpeg],
      ['comfyui', h.comfy],
      ['elevenlabs', h.elevenlabs],
    ];
    $('health').innerHTML = bits
      .map(([k, v]) => `<span class="${v ? 'good' : 'bad'}">${v ? '●' : '○'} ${k}</span>`)
      .join('');
  }

  // ---- boot -----------------------------------------------------------

  (async () => {
    await loadProject();
    renderSceneList();
    await reloadPlayer();
    await health();
  })();
})();
