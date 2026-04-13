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
    // Dynamic spawner state
    nextSourceIdx: 0,
    lastSpawnTime: 0,
    spawnBandIdx: 0, // rotates through vertical bands for even distribution

    // Playhead in seconds (drives both preview and export)
    time: 0,
    lastRealTime: 0,
    running: false, // animating (preview or export)
    exporting: false,

    // Params (synced to UI)
    bgColor: '#0a0a0a',
    speed: 0.5,
    onscreenCount: 10,
    duration: 150,
    minW: 160,
    maxW: 320,
    canvasW: 3400,
    canvasH: 1200,
    fadeTime: 0.8,
    parallax: 0.7, // fixed

    // Recorder / encoder
    recorder: null,
    recordedChunks: [],
    encoder: null,
    muxer: null,
    encoderFrameIdx: 0,
    exportFormat: 'mp4',
    statusTick: null,
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
      if (state.running) {
        const now = performance.now() / 1000;
        const dt = Math.min(0.1, now - state.lastRealTime);
        state.lastRealTime = now;
        state.time += dt;

        spawnDueClips();
        updateClips(dt);
      }

      p.background(state.bgColor);
      for (const c of state.clips) drawClip(p, c);

      // Capture frame for mp4 (WebCodecs) export — do this before stop so the
      // final frame at t≈duration still gets encoded.
      if (
        state.exporting &&
        state.exportFormat === 'mp4' &&
        state.encoder &&
        state.encoder.state === 'configured'
      ) {
        try {
          const tsUs = Math.max(1, Math.round(state.time * 1_000_000));
          // Copy p5 canvas into the dedicated 2D encode canvas first so that
          // VideoFrame can always read a valid colorSpace from it. Explicit
          // dest size downsamples HiDPI backing (p.canvas is pixelDensity×
          // larger than logical size) to the intended export resolution.
          state.encodeCtx.drawImage(
            p.canvas,
            0,
            0,
            state.encodeCanvas.width,
            state.encodeCanvas.height
          );
          const frame = new VideoFrame(state.encodeCanvas, { timestamp: tsUs });
          const keyFrame = state.encoderFrameIdx % 120 === 0;
          state.encoder.encode(frame, { keyFrame });
          frame.close();
          state.encoderFrameIdx++;
        } catch (e) {
          console.error('frame encode failed', e);
        }
      }

      if (state.running && state.time >= state.duration) {
        if (state.exporting) stopExport();
        else stopPreview();
      }
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
      const { alpha, scale } = clipTransform(c);
      if (alpha <= 0.001) return;
      if (el.readyState < 2) return;

      const vw = el.videoWidth || 640;
      const vh = el.videoHeight || 480;
      const drawW = c.size * scale;
      const drawH = (drawW * vh) / vw;

      const ctx = p.drawingContext;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(c.pos.x, c.pos.y);
      ctx.drawImage(el, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
    }

    p.exposeFit = fitCanvasToWrap;
    window._p = p;
  };

  new p5(sketch);

  // ---------- Clip lifecycle ----------
  function clipTransform(c) {
    const age = state.time - c.birthTime;
    if (age < 0) return { alpha: 0, scale: 0.6 };
    if (age < state.fadeTime) {
      const k = easeOutCubic(age / state.fadeTime);
      return { alpha: k, scale: 0.6 + 0.4 * k };
    }
    return { alpha: 1, scale: 1 };
  }

  function easeOutCubic(x) {
    return 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  }

  function spawnDueClips() {
    if (state.sources.length === 0) return;
    // Spawn cadence reacts to current speed + onscreenCount, so changes to
    // either take effect immediately mid-preview.
    const spd = Math.max(0.05, state.speed);
    const interval = Math.max(
      0.1,
      AVG_CROSS_TIME / (spd * Math.max(1, state.onscreenCount))
    );
    if (state.time - state.lastSpawnTime < interval) return;
    // Hard cap so a sudden parameter change can't pile up clips.
    if (state.clips.length >= state.onscreenCount * 1.3) {
      state.lastSpawnTime = state.time;
      return;
    }
    const idx = state.nextSourceIdx % state.sources.length;
    state.nextSourceIdx++;
    spawnClip({ sourceIndex: idx, birthTime: state.time });
    state.lastSpawnTime = state.time;
  }

  function spawnClip(entry) {
    const source = state.sources[entry.sourceIndex];
    if (!source) return;

    // Reuse the <video> element. When few sources feed many clips, several
    // on-screen clips may share an element and therefore the same frame —
    // acceptable visually, and avoids the playhead jumping mid-playback.
    const el = source.el;
    if (el.paused) {
      const pp = el.play();
      if (pp && pp.catch) pp.catch(() => {});
    }

    // Parallax depth ∈ [0,1]. 0 = far (smaller, slower), 1 = near (bigger, faster).
    const depth = Math.random();
    const px = state.parallax;
    const depthSize = 1 + (depth * 2 - 1) * px * 0.55;
    const depthSpeed = 1 + (depth * 2 - 1) * px * 0.7;

    const baseSize = randRange(state.minW, state.maxW);
    const size = Math.max(30, baseSize * depthSize);
    const startX = state.canvasW + size * 0.6;
    // Vertical safe zone: real wall is 300cm tall, clips stay within 30–270cm
    // (10% margin top & bottom). Account for clip half-size + wobble headroom.
    const topPx = state.canvasH * 0.1 + size * 0.6;
    const botPx = state.canvasH * 0.9 - size * 0.6;
    let y;
    if (topPx >= botPx) {
      y = state.canvasH * 0.5;
    } else {
      // Stratified vertical placement: divide the safe zone into N bands and
      // rotate through them so successive clips don't pile up in one area.
      const bands = Math.max(3, state.onscreenCount);
      // Multiply by a stride coprime to most band counts so the sequence
      // visits every band but in a scrambled, non-sweeping order.
      const bandIdx = (state.spawnBandIdx * 7) % bands;
      state.spawnBandIdx++;
      const bandH = (botPx - topPx) / bands;
      const center = topPx + (bandIdx + 0.5) * bandH;
      y = center + (Math.random() - 0.5) * bandH * 0.5;
    }

    // Fixed pixel velocity — average clip crosses canvas in ~AVG_CROSS_TIME s.
    const travel = state.canvasW + size * 1.2;
    const baseVx = (-travel / AVG_CROSS_TIME) * depthSpeed;

    state.clips.push({
      source,
      sourceIndex: entry.sourceIndex,
      birthTime: entry.birthTime,
      pos: { x: startX, y },
      baseVx,
      baseY: y,
      size,
      depth,
      noiseSeed: Math.random() * 10000,
    });
  }

  const AVG_CROSS_TIME = 9;

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
    }
    // Remove clips that have drifted off the left edge
    state.clips = state.clips.filter((c) => c.pos.x > -c.size);
  }

  function randRange(a, b) {
    return a + Math.random() * (b - a);
  }


  // ---------- IndexedDB persistence ----------
  const DB_NAME = 'bff-clips';
  const STORE = 'files';
  function openDB() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  async function dbPut(record) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function dbGetAll() {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }
  async function dbDelete(id) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function dbClear() {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  // ---------- File loading ----------
  function makeSource(id, name, blob) {
    const el = document.createElement('video');
    el.src = URL.createObjectURL(blob);
    el.muted = true;
    el.loop = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.style.position = 'fixed';
    el.style.left = '-10000px';
    el.style.top = '0';
    el.style.width = '2px';
    el.style.height = '2px';
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);

    const source = { id, el, name, ready: false };
    state.sources.push(source);

    el.addEventListener(
      'loadedmetadata',
      () => {
        source.ready = true;
        renderFileList();
      },
      { once: true }
    );
    return source;
  }

  async function addFiles(files) {
    const vidFiles = Array.from(files).filter((f) =>
      f.type.startsWith('video/')
    );
    if (vidFiles.length === 0) {
      setStatus('沒有偵測到影片檔', 'err');
      return;
    }
    for (const f of vidFiles) {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      makeSource(id, f.name, f);
      try {
        await dbPut({ id, name: f.name, blob: f });
      } catch (e) {
        console.warn('無法儲存到瀏覽器（檔案可能太大）', e);
      }
    }
    renderFileList();
  }

  async function loadStoredFiles() {
    try {
      const records = await dbGetAll();
      for (const r of records) makeSource(r.id, r.name, r.blob);
      renderFileList();
    } catch (e) {
      console.warn('讀取本地素材失敗', e);
    }
  }

  async function removeSource(id) {
    const idx = state.sources.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const s = state.sources[idx];
    try {
      s.el.pause();
      URL.revokeObjectURL(s.el.src);
      s.el.remove();
    } catch (e) {}
    state.sources.splice(idx, 1);
    state.clips = state.clips.filter((c) => c.source !== s);
    try {
      await dbDelete(id);
    } catch (e) {}
    renderFileList();
  }

  async function clearFiles() {
    for (const s of state.sources) {
      try {
        s.el.pause();
        URL.revokeObjectURL(s.el.src);
        s.el.remove();
      } catch (e) {}
    }
    state.sources = [];
    state.clips = [];
    try {
      await dbClear();
    } catch (e) {}
    renderFileList();
  }

  function renderFileList() {
    const countEl = document.getElementById('clip-count');
    const n = state.sources.length;
    if (countEl) {
      countEl.textContent = n === 0 ? '尚未載入素材' : `已載入 ${n} 個素材`;
    }
    const list = document.getElementById('file-list');
    if (!list) return;
    list.innerHTML = '';
    for (const s of state.sources) {
      const row = document.createElement('div');
      row.className = 'file-row';
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = s.name;
      name.title = s.name;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'file-del';
      del.textContent = '×';
      del.title = '刪除';
      del.addEventListener('click', () => removeSource(s.id));
      row.appendChild(name);
      row.appendChild(del);
      list.appendChild(row);
    }
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
    state.nextSourceIdx = 0;
    state.lastSpawnTime = -Infinity; // allow first spawn immediately
    // Preload / start playback on every source so they're decoded and ready
    for (const s of state.sources) {
      try {
        s.el.currentTime = Math.random() * 3.5;
        const pp = s.el.play();
        if (pp && pp.catch) pp.catch(() => {});
      } catch (e) {}
    }
    // Queue the first batch off-screen to the right so they stream in one by
    // one from the right edge instead of the canvas starting empty.
    if (state.sources.length > 0) {
      const initial = state.onscreenCount;
      const spacing = (state.canvasW * 1.1) / Math.max(1, initial);
      for (let i = 0; i < initial; i++) {
        const idx = state.nextSourceIdx++ % state.sources.length;
        spawnClip({ sourceIndex: idx, birthTime: 0 });
        const c = state.clips[state.clips.length - 1];
        if (c) c.pos.x = state.canvasW + c.size * 0.6 + i * spacing;
      }
    }
    state.lastSpawnTime = 0;
  }

  function waitSourcesReady(timeoutMs) {
    return new Promise((resolve) => {
      const start = performance.now();
      const check = () => {
        const allReady = state.sources.every((s) => s.el.readyState >= 2);
        if (allReady || performance.now() - start > timeoutMs) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
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

    // Wait for every source video to reach readyState >= 2 (have-current-data)
    // so the first encoded frames actually contain pixels instead of blank
    // canvas. Cap the wait so a broken source can't hang export indefinitely.
    await waitSourcesReady(1500);

    state.exportFormat = format;
    if (format === 'mp4' || format === 'mov') {
      const ok = await startMp4Export(btn);
      if (!ok) return;
    } else {
      const ok = startWebmExport(btn);
      if (!ok) return;
    }

    state.exporting = true;
    state.running = true;
    state.lastRealTime = performance.now() / 1000;
    setStatus(`錄影中…（0 / ${Math.round(state.duration)}s）`);

    state.statusTick = setInterval(() => {
      if (!state.exporting) {
        clearInterval(state.statusTick);
        state.statusTick = null;
        return;
      }
      setStatus(`錄影中…（${state.time.toFixed(1)} / ${state.duration}s）`);
    }, 250);
  }

  async function startMp4Export(btn) {
    if (typeof VideoEncoder === 'undefined' || !window.Mp4Muxer) {
      setStatus(
        '此瀏覽器不支援 WebCodecs / mp4-muxer，請改選 webm',
        'err'
      );
      btn.disabled = false;
      return false;
    }
    const w = state.canvasW;
    const h = state.canvasH;
    const fps = 60;
    const pixels = w * h;
    const bitrate = Math.min(
      80_000_000,
      Math.max(8_000_000, Math.round(pixels * 0.12))
    );

    // Pick a codec level that supports the chosen resolution. 5.2 covers up
    // to ~4K; 6.0 covers 8K. Fall back gracefully.
    const candidates = ['avc1.640034', 'avc1.640033', 'avc1.42E034', 'avc1.42E033'];
    let codec = null;
    for (const c of candidates) {
      try {
        const res = await VideoEncoder.isConfigSupported({
          codec: c,
          width: w,
          height: h,
          bitrate,
          framerate: fps,
        });
        if (res.supported) {
          codec = c;
          break;
        }
      } catch (e) {}
    }
    if (!codec) {
      setStatus('此解析度不被 H.264 編碼器支援，請降低畫布尺寸', 'err');
      btn.disabled = false;
      return false;
    }

    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: w, height: h, frameRate: fps },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        // mp4-muxer v5 requires decoderConfig.colorSpace to be non-null at
        // finalize().  Some browsers omit it; fill in BT.709 (standard SDR).
        if (meta && meta.decoderConfig && !meta.decoderConfig.colorSpace) {
          meta.decoderConfig.colorSpace = {
            primaries: 'bt709',
            transfer: 'bt709',
            matrix: 'bt709',
            fullRange: false,
          };
        }
        muxer.addVideoChunk(chunk, meta);
      },
      error: (e) => {
        console.error('VideoEncoder error', e);
        setStatus('編碼錯誤：' + e.message, 'err');
      },
    });
    encoder.configure({ codec, width: w, height: h, bitrate, framerate: fps });

    // Create a dedicated 2D canvas for VideoFrame capture.
    // VideoFrame(HTMLCanvasElement) internally reads the canvas's 2D rendering
    // context colorSpace; if p5's canvas context is unavailable it throws
    // "Cannot read properties of null (reading 'colorSpace')".  Drawing each
    // frame into a fresh 2D canvas first avoids this.
    const encodeCanvas = document.createElement('canvas');
    encodeCanvas.width = w;
    encodeCanvas.height = h;
    // Explicit sRGB colorSpace so VideoFrames carry a valid colorSpace into
    // the encoder's decoderConfig — mp4-muxer v5 dereferences it during
    // finalize() and throws if null.
    const encodeCtx = encodeCanvas.getContext('2d', { colorSpace: 'srgb' });

    state.encoder = encoder;
    state.muxer = muxer;
    state.encodeCanvas = encodeCanvas;
    state.encodeCtx = encodeCtx;
    state.encoderFrameIdx = 0;
    return true;
  }

  function startWebmExport(btn) {
    const mimeType = pickMimeType();
    if (!mimeType) {
      setStatus('此瀏覽器不支援 MediaRecorder webm，無法匯出', 'err');
      btn.disabled = false;
      return false;
    }
    const stream = window._p.canvas.captureStream(60);
    state.recordedChunks = [];
    const pixels = state.canvasW * state.canvasH;
    const bitrate = Math.min(
      80_000_000,
      Math.max(8_000_000, Math.round(pixels * 5))
    );
    state.recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: bitrate,
    });
    state.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.recordedChunks.push(e.data);
    };
    state.recorder.onstop = () => {
      const blob = new Blob(state.recordedChunks, { type: mimeType });
      state.recordedChunks = [];
      downloadBlob(blob, `floating_${ts()}.webm`);
      setStatus('完成！webm 已下載', 'ok');
      btn.disabled = false;
    };
    state.recorder.start(500);
    return true;
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

  function stopExport() {
    if (!state.exporting) return;
    state.running = false;
    state.exporting = false;
    if (state.statusTick) {
      clearInterval(state.statusTick);
      state.statusTick = null;
    }
    if (state.exportFormat === 'mp4' || state.exportFormat === 'mov') {
      finalizeMp4Export();
    } else if (state.exportFormat === 'webm') {
      if (state.recorder && state.recorder.state !== 'inactive') {
        state.recorder.stop();
      }
    }
  }

  async function finalizeMp4Export() {
    const btn = document.getElementById('btn-export');
    try {
      setStatus('完成編碼中…');
      await state.encoder.flush();
      state.muxer.finalize();
      const buffer = state.muxer.target.buffer;
      const isMov = state.exportFormat === 'mov';
      const mime = isMov ? 'video/quicktime' : 'video/mp4';
      const ext = isMov ? 'mov' : 'mp4';
      downloadBlob(
        new Blob([buffer], { type: mime }),
        `floating_${ts()}.${ext}`
      );
      setStatus(`完成！${ext} 已下載`, 'ok');
    } catch (e) {
      console.error(e);
      setStatus('匯出失敗：' + e.message, 'err');
    } finally {
      try {
        state.encoder && state.encoder.close();
      } catch (e) {}
      state.encoder = null;
      state.muxer = null;
      state.encodeCanvas = null;
      state.encodeCtx = null;
      btn.disabled = false;
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

    loadStoredFiles();

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

    const wIn = $('canvas-w');
    const hIn = $('canvas-h');
    const preset = $('canvas-preset');
    const applyCanvasSize = () => {
      const w = Math.max(320, Math.min(7680, parseInt(wIn.value, 10) || 1920));
      const h = Math.max(180, Math.min(4320, parseInt(hIn.value, 10) || 1080));
      state.canvasW = w;
      state.canvasH = h;
      window._p.resizeCanvas(w, h);
      if (window._p.exposeFit) window._p.exposeFit();
    };
    preset.addEventListener('change', (e) => {
      if (e.target.value === 'custom') return;
      const [w, h] = e.target.value.split('x').map(Number);
      wIn.value = w;
      hIn.value = h;
      applyCanvasSize();
    });
    [wIn, hIn].forEach((el) =>
      el.addEventListener('input', () => {
        preset.value = 'custom';
        applyCanvasSize();
      })
    );
    applyCanvasSize();

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
      default:
        return String(v);
    }
  }
})();
