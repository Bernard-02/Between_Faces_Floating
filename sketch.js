/*
 * Between Faces Floating — p5.js sketch
 *
 * Loads user-uploaded 4s ping-pong videos and renders them as floating
 * clips that enter from the right and drift out to the left, with
 * entry/exit fade+scale animations. Supports canvas capture via
 * MediaRecorder so the whole sequence can be exported.
 */

(() => {
  // ---------- State ----------
  const state = {
    // User-uploaded video elements (all pre-created, hidden)
    sources: [], // { el: HTMLVideoElement, name, ready }
    // Active floating clips on-screen
    clips: [],
    // Schedule: array of { sourceIndex, birthTime, deathTime }
    schedule: [],
    nextScheduleIdx: 0,

    // Playhead in seconds (drives both preview and export)
    time: 0,
    lastRealTime: 0,
    running: false, // animating (preview or export)
    exporting: false,

    // Params (synced to UI)
    bgColor: '#0a0a0a',
    speed: 1.0,
    onscreenCount: 15,
    duration: 150,
    minW: 160,
    maxW: 320,
    canvasW: 1920,
    canvasH: 1080,
    fadeTime: 0.8,

    // Recorder
    recorder: null,
    recordedChunks: [],
  };

  // Expose a minimal hook for the ffmpeg helper
  window.BFF = state;

  // ---------- p5 sketch ----------
  const sketch = (p) => {
    let pg = null; // offscreen renderer we draw to so we always capture 1:1

    p.setup = () => {
      const wrap = document.getElementById('canvas-wrap');
      const cnv = p.createCanvas(state.canvasW, state.canvasH);
      cnv.parent(wrap);
      fitCanvasToWrap();
      p.frameRate(60);
      p.noStroke();
      window.addEventListener('resize', fitCanvasToWrap);
    };

    p.draw = () => {
      // Advance time
      if (state.running) {
        const now = performance.now() / 1000;
        const dt = Math.min(0.1, now - state.lastRealTime);
        state.lastRealTime = now;
        state.time += dt;

        spawnDueClips();
        updateClips(dt);

        // Stop when done (export or preview)
        if (state.time >= state.duration) {
          if (state.exporting) {
            stopExport();
          } else {
            stopPreview();
          }
        }
      }

      // Draw
      p.background(state.bgColor);
      for (const c of state.clips) drawClip(p, c);
    };

    p.windowResized = fitCanvasToWrap;

    function fitCanvasToWrap() {
      const wrap = document.getElementById('canvas-wrap');
      if (!wrap || !p.canvas) return;
      const aspect = state.canvasW / state.canvasH;
      const rect = wrap.getBoundingClientRect();
      const maxW = rect.width - 4;
      const maxH = rect.height - 4;
      let w = maxW;
      let h = w / aspect;
      if (h > maxH) {
        h = maxH;
        w = h * aspect;
      }
      p.canvas.style.width = `${Math.max(10, Math.floor(w))}px`;
      p.canvas.style.height = `${Math.max(10, Math.floor(h))}px`;
    }

    function drawClip(p, c) {
      const el = c.source.el;
      // Compute alpha+scale from phase
      const { alpha, scale } = clipTransform(c);
      if (alpha <= 0.001) return;

      // Video may not be ready yet; skip until metadata loaded
      if (el.readyState < 2) return;

      const vw = el.videoWidth || 640;
      const vh = el.videoHeight || 480;
      const drawW = c.size * scale;
      const drawH = (drawW * vh) / vw;

      p.push();
      p.translate(c.pos.x, c.pos.y);
      if (c.rotation) p.rotate(c.rotation);
      p.tint(255, 255 * alpha);
      // p5 can draw HTMLVideoElement directly via image()
      p.imageMode(p.CENTER);
      p.image(el, 0, 0, drawW, drawH);
      p.pop();
    }

    p.exposeFit = fitCanvasToWrap;
    window._p = p;
  };

  new p5(sketch);

  // ---------- Clip lifecycle ----------
  function clipTransform(c) {
    const t = state.time;
    const inStart = c.birthTime;
    const inEnd = c.birthTime + state.fadeTime;
    const outStart = c.deathTime - state.fadeTime;
    const outEnd = c.deathTime;

    let alpha = 1;
    let scale = 1;
    if (t < inStart) {
      alpha = 0;
      scale = 0.6;
    } else if (t < inEnd) {
      const k = easeOutCubic((t - inStart) / state.fadeTime);
      alpha = k;
      scale = 0.6 + 0.4 * k;
    } else if (t < outStart) {
      alpha = 1;
      scale = 1;
    } else if (t < outEnd) {
      const k = 1 - easeInCubic((t - outStart) / state.fadeTime);
      alpha = k;
      scale = 0.6 + 0.4 * k;
    } else {
      alpha = 0;
      scale = 0.6;
    }
    return { alpha, scale };
  }

  function easeOutCubic(x) {
    return 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  }
  function easeInCubic(x) {
    const k = Math.min(1, Math.max(0, x));
    return k * k * k;
  }

  function spawnDueClips() {
    while (
      state.nextScheduleIdx < state.schedule.length &&
      state.schedule[state.nextScheduleIdx].birthTime <= state.time
    ) {
      const entry = state.schedule[state.nextScheduleIdx++];
      spawnClip(entry);
    }
  }

  function spawnClip(entry) {
    const source = state.sources[entry.sourceIndex];
    if (!source) return;

    // Clone-free: reuse the <video> element. Since each source is unique in the
    // schedule (83 clips, 83 sources), reusing the element is fine.
    const el = source.el;
    // Give each a random phase within its 4s ping-pong loop
    try {
      el.currentTime = Math.random() * Math.max(0.1, (el.duration || 4) - 0.1);
    } catch (e) {
      /* noop */
    }
    // Ensure playing
    const playPromise = el.play();
    if (playPromise && playPromise.catch) playPromise.catch(() => {});

    const size = randRange(state.minW, state.maxW);
    // Start just past right edge
    const startX = state.canvasW + size * 0.6;
    const y = randRange(size * 0.4, state.canvasH - size * 0.4);

    // Leftward drift so the clip naturally exits to the left by deathTime
    const lifeLen = Math.max(0.1, entry.deathTime - entry.birthTime);
    const travel = state.canvasW + size * 1.2;
    const baseVx = -travel / lifeLen;

    state.clips.push({
      source,
      sourceIndex: entry.sourceIndex,
      birthTime: entry.birthTime,
      deathTime: entry.deathTime,
      pos: { x: startX, y },
      baseVx,
      baseY: y,
      size,
      rotation: (Math.random() - 0.5) * 0.08,
      noiseSeed: Math.random() * 10000,
    });
  }

  function updateClips(dt) {
    const t = state.time;
    for (const c of state.clips) {
      // Leftward drift scaled by global speed
      c.pos.x += c.baseVx * state.speed * dt;
      // Gentle vertical wobble via sin + noise offset
      const phase = (t + c.noiseSeed) * 0.6;
      c.pos.y =
        c.baseY +
        Math.sin(phase) * c.size * 0.12 +
        Math.sin(phase * 0.37 + 1.3) * c.size * 0.06;
      // Slight rotation sway
      c.rotation = Math.sin(phase * 0.5) * 0.06;
    }
    // Remove finished clips
    state.clips = state.clips.filter((c) => t < c.deathTime + 0.2);
  }

  function randRange(a, b) {
    return a + Math.random() * (b - a);
  }

  // ---------- Scheduler ----------
  function buildSchedule() {
    const total = state.sources.length;
    if (total === 0) {
      state.schedule = [];
      return;
    }

    const duration = state.duration;
    const startBuf = Math.min(2.5, duration * 0.1);
    const endBuf = Math.min(6, duration * 0.15);
    const firstBatch = Math.min(state.onscreenCount, total);

    const schedule = [];

    // First batch — staggered entry during startBuf
    for (let i = 0; i < firstBatch; i++) {
      const birth = (i / Math.max(1, firstBatch)) * startBuf;
      schedule.push({ sourceIndex: i, birthTime: birth });
    }

    // Remaining — evenly spaced through middle phase
    const remaining = total - firstBatch;
    const midStart = startBuf;
    const midEnd = duration - endBuf;
    const midLen = Math.max(0.1, midEnd - midStart);
    const interval = remaining > 0 ? midLen / remaining : 0;

    for (let i = 0; i < remaining; i++) {
      const birth = midStart + (i + 0.5) * interval;
      schedule.push({ sourceIndex: firstBatch + i, birthTime: birth });
    }

    // Per-clip lifespan ≈ onscreen * interval, so roughly `onscreenCount`
    // stay alive during the middle phase. Clamp so everyone finishes before
    // `duration`.
    const lifespan = Math.max(
      state.fadeTime * 3,
      Math.max(interval, 0.3) * firstBatch
    );

    for (const e of schedule) {
      e.deathTime = Math.min(duration, e.birthTime + lifespan);
    }

    // Shuffle sourceIndex assignment so ordering isn't strictly by upload order
    const shuffledSources = shuffledIndices(total);
    schedule.forEach((e, i) => {
      e.sourceIndex = shuffledSources[i];
    });

    // Sort by birthTime for spawn loop
    schedule.sort((a, b) => a.birthTime - b.birthTime);
    state.schedule = schedule;
  }

  function shuffledIndices(n) {
    const arr = Array.from({ length: n }, (_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- File loading ----------
  function addFiles(files) {
    const vidFiles = Array.from(files).filter((f) =>
      f.type.startsWith('video/')
    );
    if (vidFiles.length === 0) {
      setStatus('沒有偵測到影片檔', 'err');
      return;
    }

    for (const f of vidFiles) {
      const el = document.createElement('video');
      el.src = URL.createObjectURL(f);
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      // Position far offscreen instead of display:none so Chrome doesn't
      // throttle/skip decoding frames for hidden <video> elements. We still
      // draw them to the canvas via p.image().
      el.style.position = 'fixed';
      el.style.left = '-10000px';
      el.style.top = '0';
      el.style.width = '2px';
      el.style.height = '2px';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      document.body.appendChild(el);

      const source = { el, name: f.name, ready: false };
      state.sources.push(source);

      el.addEventListener(
        'loadedmetadata',
        () => {
          source.ready = true;
          updateClipCount();
        },
        { once: true }
      );
    }
    updateClipCount();
  }

  function clearFiles() {
    for (const s of state.sources) {
      try {
        s.el.pause();
        URL.revokeObjectURL(s.el.src);
        s.el.remove();
      } catch (e) {}
    }
    state.sources = [];
    state.clips = [];
    state.schedule = [];
    state.nextScheduleIdx = 0;
    updateClipCount();
  }

  function updateClipCount() {
    const el = document.getElementById('clip-count');
    const n = state.sources.length;
    el.textContent = n === 0 ? '尚未載入素材' : `已載入 ${n} 個素材`;
  }

  // ---------- Preview / Export ----------
  function startPreview() {
    if (state.sources.length === 0) {
      setStatus('請先上傳影片素材', 'err');
      return;
    }
    resetPlayback();
    state.running = true;
    state.exporting = false;
    state.lastRealTime = performance.now() / 1000;
    setStatus('預覽中…');
  }

  function stopPreview() {
    state.running = false;
    setStatus('');
  }

  function resetPlayback() {
    state.time = 0;
    state.clips = [];
    state.nextScheduleIdx = 0;
    buildSchedule();
    // Preload / start playback on every source so they're decoded and ready
    for (const s of state.sources) {
      try {
        s.el.currentTime = Math.random() * 3.5;
        const pp = s.el.play();
        if (pp && pp.catch) pp.catch(() => {});
      } catch (e) {}
    }
  }

  async function startExport() {
    if (state.sources.length === 0) {
      setStatus('請先上傳影片素材', 'err');
      return;
    }
    if (state.exporting) return;

    const format = document.getElementById('out-format').value;
    const btn = document.getElementById('btn-export');
    btn.disabled = true;

    setStatus('準備錄影…');
    resetPlayback();

    // Pick a supported webm mime type
    const mimeType = pickMimeType();
    if (!mimeType) {
      setStatus('此瀏覽器不支援 MediaRecorder webm，無法匯出', 'err');
      btn.disabled = false;
      return;
    }

    const stream = window._p.canvas.captureStream(60);
    state.recordedChunks = [];
    state.recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 12_000_000,
    });

    state.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.recordedChunks.push(e.data);
    };

    state.recorder.onstop = async () => {
      const webmBlob = new Blob(state.recordedChunks, { type: mimeType });
      state.recordedChunks = [];
      await handleExportBlob(webmBlob, format);
      btn.disabled = false;
    };

    state.exporting = true;
    state.running = true;
    state.lastRealTime = performance.now() / 1000;
    state.recorder.start(500);
    setStatus(`錄影中…（0 / ${Math.round(state.duration)}s）`);

    // Update status as we go
    const tick = setInterval(() => {
      if (!state.exporting) {
        clearInterval(tick);
        return;
      }
      setStatus(
        `錄影中…（${state.time.toFixed(1)} / ${state.duration}s）`
      );
    }, 250);
  }

  function stopExport() {
    state.running = false;
    if (state.recorder && state.recorder.state !== 'inactive') {
      state.recorder.stop();
    }
    state.exporting = false;
  }

  function pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    for (const t of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    }
    return null;
  }

  async function handleExportBlob(webmBlob, format) {
    if (format === 'webm') {
      downloadBlob(webmBlob, `floating_${ts()}.webm`);
      setStatus('完成！webm 已下載', 'ok');
      return;
    }

    setStatus('轉檔中（webm → ' + format + '）… 這可能需要幾分鐘');
    try {
      const out = await window.BFFConvert.convert(webmBlob, format, (msg) => {
        setStatus(msg);
      });
      downloadBlob(out, `floating_${ts()}.${format}`);
      setStatus(`完成！${format} 已下載`, 'ok');
    } catch (err) {
      console.error(err);
      setStatus('轉檔失敗：' + err.message + '（改下載 webm）', 'err');
      downloadBlob(webmBlob, `floating_${ts()}.webm`);
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function ts() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      '_' +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds())
    );
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('status');
    el.textContent = msg || '';
    el.classList.remove('ok', 'err');
    if (kind) el.classList.add(kind);
  }

  // ---------- UI wiring ----------
  document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);

    // File input + drag/drop
    $('file-input').addEventListener('change', (e) => {
      if (e.target.files) addFiles(e.target.files);
      e.target.value = '';
    });
    const dz = $('drop-zone');
    ['dragenter', 'dragover'].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.add('dragover');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.remove('dragover');
      })
    );
    dz.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files) {
        addFiles(e.dataTransfer.files);
      }
    });
    $('btn-clear').addEventListener('click', clearFiles);

    // Controls
    const bind = (id, valId, transform, onChange) => {
      const el = $(id);
      const valEl = valId ? $(valId) : null;
      const update = () => {
        const v = transform ? transform(el.value) : el.value;
        onChange(v);
        if (valEl) valEl.textContent = formatForLabel(id, v);
      };
      el.addEventListener('input', update);
      update();
    };

    bind('bg-color', null, null, (v) => (state.bgColor = v));
    bind('speed', 'speed-val', parseFloat, (v) => (state.speed = v));
    bind('onscreen', 'onscreen-val', parseInt, (v) => (state.onscreenCount = v));
    bind('duration', 'duration-val', parseInt, (v) => (state.duration = v));
    bind('minw', 'minw-val', parseInt, (v) => (state.minW = v));
    bind('maxw', 'maxw-val', parseInt, (v) => (state.maxW = v));
    bind('fade', 'fade-val', parseFloat, (v) => (state.fadeTime = v));

    $('canvas-size').addEventListener('change', (e) => {
      const [w, h] = e.target.value.split('x').map(Number);
      state.canvasW = w;
      state.canvasH = h;
      window._p.resizeCanvas(w, h);
      if (window._p.exposeFit) window._p.exposeFit();
    });

    $('btn-preview').addEventListener('click', startPreview);
    $('btn-stop').addEventListener('click', () => {
      stopPreview();
      if (state.exporting) stopExport();
    });
    $('btn-export').addEventListener('click', startExport);
  });

  function formatForLabel(id, v) {
    switch (id) {
      case 'speed':
        return v.toFixed(1) + 'x';
      case 'fade':
        return v.toFixed(1);
      default:
        return String(v);
    }
  }
})();
