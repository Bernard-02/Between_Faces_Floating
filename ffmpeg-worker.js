/*
 * ffmpeg-worker.js — thin wrapper around ffmpeg.wasm 0.11.x for converting
 * the canvas-captured webm blob into an H.264 mp4/mov file in-browser.
 *
 * 0.11.x is used (rather than 0.12.x) because its default build does NOT
 * require SharedArrayBuffer / COOP+COEP headers, so it works behind a
 * plain `python -m http.server`.
 */

(() => {
  // @ffmpeg/ffmpeg 0.11.x UMD exposes the global `FFmpeg`
  const globalFFmpeg = window.FFmpeg;

  let ffmpeg = null;
  let loading = null;

  async function ensureLoaded(onProgress) {
    if (ffmpeg && ffmpeg.isLoaded()) return ffmpeg;
    if (loading) return loading;

    if (!globalFFmpeg || !globalFFmpeg.createFFmpeg) {
      throw new Error('ffmpeg.wasm 未載入（檢查網路或 CDN）');
    }

    const { createFFmpeg } = globalFFmpeg;
    ffmpeg = createFFmpeg({
      log: false,
      corePath:
        'https://cdn.jsdelivr.net/npm/@ffmpeg/[email protected]/dist/ffmpeg-core.js',
      progress: ({ ratio }) => {
        if (typeof ratio === 'number' && onProgress) {
          const pct = Math.max(0, Math.min(1, ratio)) * 100;
          onProgress(`轉檔中… ${pct.toFixed(0)}%`);
        }
      },
    });

    loading = ffmpeg.load().then(() => ffmpeg);
    await loading;
    loading = null;
    return ffmpeg;
  }

  async function blobToUint8(blob) {
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
  }

  async function convert(webmBlob, format, onStatus) {
    if (!['mp4', 'mov'].includes(format)) {
      throw new Error('不支援的格式：' + format);
    }
    onStatus && onStatus('載入 ffmpeg.wasm（首次約 20MB）…');
    const ff = await ensureLoaded(onStatus);

    onStatus && onStatus('寫入來源檔…');
    const inName = 'in.webm';
    const outName = 'out.' + format;
    ff.FS('writeFile', inName, await blobToUint8(webmBlob));

    // Encode H.264 + faststart so QuickTime/VLC play it nicely.
    const args = [
      '-i',
      inName,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outName,
    ];

    onStatus && onStatus('轉檔中… 0%');
    await ff.run(...args);

    const data = ff.FS('readFile', outName);
    // Clean up the MEMFS so next run starts fresh
    try {
      ff.FS('unlink', inName);
      ff.FS('unlink', outName);
    } catch (e) {}

    const mime = format === 'mp4' ? 'video/mp4' : 'video/quicktime';
    return new Blob([data.buffer], { type: mime });
  }

  window.BFFConvert = { convert };
})();
