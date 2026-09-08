/* Studio UI. Phase 1: scene editing, scrubbing, export.
 *
 * Playback here is the second "driver" of the shared renderer: it calls the
 * same window.seek(t) inside the player iframe that the headless export calls.
 */

(() => {
  'use strict';

  const PROJECT = 'ff';

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

  // Length of the editable scenes only.
  const scenesDur = () => {
    if (!project || !project.scenes.length) return 0;
    const last = project.scenes[project.scenes.length - 1];
    return last.start + last.duration;
  };

  // Full length of the exported video: the scenes plus the branded outro that
  // is concatenated on at export. The scrubber spans this, so the timeline
  // matches the finished MP4 rather than stopping short of it.
  let outroDur = 0;
  const dur = () => scenesDur() + outroDur;

  const playerWin = () => iframe.contentWindow;

  async function seek(t) {
    const w = playerWin();
    if (w && typeof w.seek === 'function') await w.seek(t);
    timeLabel.textContent = `${t.toFixed(2)} / ${dur().toFixed(2)}`;
  }

  // ---- loading --------------------------------------------------------

  async function loadOutroInfo() {
    try {
      const info = await (await fetch('/api/outro')).json();
      outroDur = info.exists ? info.duration : 0;
    } catch (e) { outroDur = 0; }
  }

  async function loadProject() {
    // with_outro=false: the outro is presentation only, and saving it back
    // would turn it into a real scene and double it at export.
    let res = await fetch(`/api/projects/${PROJECT}?with_outro=false`);
    if (res.status === 404) {
      await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: PROJECT }),
      });
      res = await fetch(`/api/projects/${PROJECT}?with_outro=false`);
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

      if (scene.image.asset) {
        const thumb = document.createElement('img');
        thumb.className = 'thumb';
        thumb.src = `/media/${PROJECT}/${scene.image.asset}?t=${scene.image.hash || ''}`;
        card.appendChild(thumb);
      }

      const imgRow = document.createElement('div');
      imgRow.className = 'row';
      const reroll = document.createElement('button');
      reroll.className = 'btn small';
      reroll.textContent = scene.image.asset ? '🎲 Re-roll image' : '🖼 Generate image';
      reroll.addEventListener('click', () => {
        runJob(
          `/api/projects/${PROJECT}/images?scene_id=${scene.id}`,
          reroll, {}, `images_${PROJECT}`,
        );
      });
      imgRow.appendChild(reroll);

      const lock = document.createElement('button');
      lock.className = 'btn small';
      lock.textContent = scene.image.locked ? '🔒 Locked' : '🔓 Lock';
      lock.title = 'Locked images are never regenerated';
      lock.addEventListener('click', () => {
        scene.image.locked = !scene.image.locked;
        save();
      });
      imgRow.appendChild(lock);
      card.appendChild(imgRow);

      const ip = document.createElement('textarea');
      ip.value = scene.image.prompt || '';
      ip.placeholder = 'Image prompt (avoid people/hands)';
      ip.addEventListener('input', () => { scene.image.prompt = ip.value; save(); });
      card.appendChild(labelled('Image prompt', ip));

      const cw = document.createElement('input');
      cw.type = 'text';
      cw.value = scene.card.word;
      cw.placeholder = 'ENGLISH WORD';
      cw.addEventListener('input', () => { scene.card.word = cw.value; save(); });
      card.appendChild(labelled('Word', cw));

      const cl = document.createElement('input');
      cl.type = 'text';
      cl.value = scene.card.looks_like;
      cl.placeholder = 'изглежда като…';
      cl.addEventListener('input', () => { scene.card.looks_like = cl.value; save(); });
      card.appendChild(labelled('Looks like (wrong)', cl));

      const ca = document.createElement('input');
      ca.type = 'text';
      ca.value = scene.card.actually;
      ca.placeholder = 'всъщност значи…';
      ca.addEventListener('input', () => { scene.card.actually = ca.value; save(); });
      card.appendChild(labelled('Actually means', ca));

      const vo = document.createElement('textarea');
      vo.value = scene.voice.text;
      vo.placeholder = 'Bulgarian voice-over line';
      vo.addEventListener('input', () => { scene.voice.text = vo.value; save(); });
      card.appendChild(labelled('Voice-over', vo));

      if (scene.voice.asset) {
        const au = document.createElement('audio');
        au.controls = true;
        au.src = `/media/${PROJECT}/${scene.voice.asset}`;
        au.style.width = '100%';
        card.appendChild(au);
      }

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
      card.appendChild(labelled('Duration (s) — derived from voice when present', secs));

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
    syncAudio(t);
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
    stopAllAudio();
  }

  playBtn.addEventListener('click', () => (playing ? stop() : play()));
  scrub.addEventListener('input', () => {
    stop();
    seek(Number(scrub.value) * dur());
  });

  // ---- preview audio --------------------------------------------------
  // The player itself stays silent (it must be a pure function of time), so
  // the studio plays the voice-over alongside it just for monitoring.

  const voAudio = new Map();

  function primeAudio() {
    voAudio.clear();
    for (const s of project.scenes) {
      if (!s.voice.asset) continue;
      const a = new Audio(`/media/${PROJECT}/${s.voice.asset}`);
      a.preload = 'auto';
      voAudio.set(s.id, a);
    }
  }

  function stopAllAudio() {
    for (const a of voAudio.values()) { a.pause(); }
  }

  /** Start/stop clips so what you hear matches the playhead. */
  function syncAudio(t) {
    for (const s of project.scenes) {
      const a = voAudio.get(s.id);
      if (!a) continue;
      const local = t - s.start;
      const inside = local >= 0 && local < (s.voice.duration || 0);
      if (inside && a.paused) {
        a.currentTime = Math.max(0, local);
        a.play().catch(() => {});
      } else if (!inside && !a.paused) {
        a.pause();
      }
    }
  }

  // ---- export ---------------------------------------------------------

  async function runJob(url, btn, body, jobId) {
    const status = $('exportStatus');
    const others = [$('makeBtn'), $('exportBtn')];
    others.forEach((b) => (b.disabled = true));
    status.className = 'status';
    status.textContent = 'Starting…';

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      status.className = 'status err';
      status.textContent = (await res.json()).detail || 'Failed to start';
      others.forEach((b) => (b.disabled = false));
      return;
    }
    const { job } = await res.json();
    void jobId;

    const poll = setInterval(async () => {
      const j = await (await fetch(`/api/jobs/${job}`)).json();
      status.textContent = `${j.message} (${Math.round((j.progress || 0) * 100)}%)`;
      if (j.status === 'done') {
        clearInterval(poll);
        status.className = 'status ok';
        status.textContent = j.message;
        await loadExisting();
        others.forEach((b) => (b.disabled = false));
        // The scenes changed if this was a "make", so refresh everything.
        await loadProject();
        primeAudio();
        renderSceneList();
        await reloadPlayer();
      } else if (j.status === 'error') {
        clearInterval(poll);
        status.className = 'status err';
        status.textContent = j.message;
        others.forEach((b) => (b.disabled = false));
      }
    }, 500);
  }

  $('exportBtn').addEventListener('click', () =>
    runJob(`/api/projects/${PROJECT}/export`, $('exportBtn')));

  $('makeBtn').addEventListener('click', () => {
    const count = Math.max(1, Math.min(6, Number($('wordCount').value) || 5));
    runJob(`/api/projects/${PROJECT}/make`, $('makeBtn'), { count, intro: true });
  });

  $('addScene').addEventListener('click', async () => {
    await fetch(`/api/projects/${PROJECT}/scenes`, { method: 'POST' });
    await loadProject();
    renderSceneList();
    await reloadPlayer();
  });

  /** Populate the picker from the output folder and show the newest video. */
  async function loadExisting(preferName) {
    let videos = [];
    try {
      videos = await (await fetch('/api/videos')).json();
    } catch (e) { return; }
    if (!videos.length) return;

    const pick = $('videoPick');
    const keep = preferName || pick.value;
    pick.innerHTML = '';
    for (const v of videos) {
      const o = document.createElement('option');
      o.value = v.name;
      const when = new Date(v.mtime * 1000);
      o.textContent = `${v.stem}  ·  ${when.toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit',
      })}`;
      pick.appendChild(o);
    }
    // Keep the current selection across a refresh when it still exists.
    pick.value = videos.some((v) => v.name === keep) ? keep : videos[0].name;

    $('resultCol').style.display = 'flex';
    showVideo(pick.value, videos);
  }

  function showVideo(name, videos) {
    const v = $('result');
    v.src = `/api/video/${encodeURIComponent(name)}?t=${Date.now()}`;
    v.style.display = 'block';
    const info = (videos || []).find((x) => x.name === name);
    $('videoMeta').textContent = info
      ? `${(info.size / 1048576).toFixed(1)} MB`
      : '';
  }

  $('videoPick').addEventListener('change', async (e) => {
    const videos = await (await fetch('/api/videos')).json();
    showVideo(e.target.value, videos);
  });

  $('revealBtn').addEventListener('click', () => {
    fetch('/api/reveal', { method: 'POST' });
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
    await loadOutroInfo();
    await loadProject();
    primeAudio();
    renderSceneList();
    await reloadPlayer();
    await loadExisting();
    await health();
  })();
})();
