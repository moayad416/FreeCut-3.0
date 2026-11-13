/* FreeCut Mobile — auto-cut analysis (offline, on-device).
 * Silence detection + scene-cut detection + WAV encoding for caption uploads.
 * Pure functions are exported for Node tests; browser parts use Web Audio/canvas.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(root);
  else root.FCAuto = factory(root);
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  // ---------------------------------------------------------------- pure
  /**
   * Find silent intervals in PCM samples.
   * samples: Float32Array (mono), sampleRate: number.
   * opts: {threshold (RMS 0..1, default 0.02), minDur (s, default 0.5), pad (s, default 0.1)}
   * Returns [{start, end}] in seconds, sorted, non-overlapping.
   */
  function detectSilences(samples, sampleRate, opts) {
    opts = opts || {};
    const threshold = opts.threshold != null ? opts.threshold : 0.02;
    const minDur = opts.minDur != null ? opts.minDur : 0.5;
    const pad = opts.pad != null ? opts.pad : 0.1;
    const win = Math.max(1, Math.floor(sampleRate * 0.05)); // 50 ms windows
    const nWin = Math.floor(samples.length / win);
    const silent = new Array(nWin);
    for (let i = 0; i < nWin; i++) {
      let sum = 0;
      const off = i * win;
      for (let j = 0; j < win; j++) { const v = samples[off + j]; sum += v * v; }
      silent[i] = Math.sqrt(sum / win) < threshold;
    }
    // merge adjacent silent windows
    const raw = [];
    let s = -1;
    for (let i = 0; i < nWin; i++) {
      if (silent[i] && s < 0) s = i;
      if ((!silent[i] || i === nWin - 1) && s >= 0) {
        const e = silent[i] ? i + 1 : i;
        raw.push({ start: (s * win) / sampleRate, end: (e * win) / sampleRate });
        s = -1;
      }
    }
    const total = samples.length / sampleRate;
    return raw
      .filter((r) => r.end - r.start >= minDur)
      .map((r) => ({
        start: Math.max(0, r.start + pad),
        end: Math.min(total, r.end - pad),
      }))
      .filter((r) => r.end - r.start > 0.05);
  }

  /**
   * Invert silences within [inT, outT] into keep-ranges (min 0.25s each).
   */
  function keepRanges(inT, outT, silences) {
    const keep = [];
    let cur = inT;
    for (const s of silences) {
      if (s.end <= inT || s.start >= outT) continue;
      const cs = Math.max(inT, s.start), ce = Math.min(outT, s.end);
      if (cs - cur >= 0.25) keep.push({ start: cur, end: cs });
      cur = Math.max(cur, ce);
    }
    if (outT - cur >= 0.25) keep.push({ start: cur, end: outT });
    return keep;
  }

  /**
   * From an array of frame-difference scores (0..1), pick cut timestamps.
   * interval: seconds between samples. threshold: default 0.25. minGap: s.
   */
  function pickSceneCuts(diffs, interval, threshold, minGap) {
    threshold = threshold != null ? threshold : 0.25;
    minGap = minGap != null ? minGap : 1.0;
    const cuts = [];
    let last = -Infinity;
    for (let i = 0; i < diffs.length; i++) {
      const t = (i + 1) * interval;
      if (diffs[i] >= threshold && t - last >= minGap) {
        cuts.push(t);
        last = t;
      }
    }
    return cuts;
  }

  /** Mean absolute difference between two small RGBA frames (0..1). */
  function frameDiff(a, b) {
    const n = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < n; i += 4) {
      sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    }
    return sum / ((n / 4) * 3 * 255);
  }

  // ---------------------------------------------------------------- browser
  /** Decode a media file to mono Float32Array PCM at 16 kHz. */
  async function decodeAudio(file) {
    const AC = root.AudioContext || root.webkitAudioContext;
    const ctx = new AC();
    try {
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      // downmix to mono at native rate (resample happens in encodeWav if needed)
      const ch0 = buf.getChannelData(0);
      const out = new Float32Array(buf.length);
      out.set(ch0);
      for (let c = 1; c < buf.numberOfChannels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < out.length; i++) out[i] = (out[i] + ch[i]) / 2;
      }
      return { samples: out, sampleRate: buf.sampleRate, duration: buf.duration };
    } finally {
      if (ctx.close) ctx.close();
    }
  }

  /**
   * Sample frames of a video file every `interval` seconds, return {cuts, diffs}.
   * onProgress(0..1).
   */
  async function detectScenesInFile(url, duration, interval, onProgress) {
    interval = interval || 0.5;
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.preload = "auto";
    video.src = url;
    await new Promise((res, rej) => {
      video.onloadeddata = res;
      video.onerror = () => rej(new Error("Could not read the video"));
    });
    const W = 64, H = 36;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    const diffs = [];
    let prev = null;
    const steps = Math.floor(duration / interval);
    for (let i = 1; i <= steps; i++) {
      const t = i * interval;
      await new Promise((res) => {
        video.onseeked = res;
        video.currentTime = Math.min(t, duration - 0.05);
      });
      g.drawImage(video, 0, 0, W, H);
      const data = g.getImageData(0, 0, W, H).data;
      if (prev) diffs.push(frameDiff(prev, data));
      prev = data;
      if (onProgress) onProgress(i / steps);
    }
    return { diffs, cuts: pickSceneCuts(diffs, interval), interval };
  }

  /** Resample PCM to 16 kHz mono WAV bytes (for caption upload). */
  function encodeWav16k(samples, sampleRate) {
    const ratio = sampleRate / 16000;
    const outLen = Math.floor(samples.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const v = samples[Math.floor(i * ratio)] || 0;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    const buf = new ArrayBuffer(44 + outLen * 2);
    const dv = new DataView(buf);
    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, "RIFF"); dv.setUint32(4, 36 + outLen * 2, true); wstr(8, "WAVE");
    wstr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
    dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    wstr(36, "data"); dv.setUint32(40, outLen * 2, true);
    new Int16Array(buf, 44).set(out);
    return new Uint8Array(buf);
  }

  return { detectSilences, keepRanges, pickSceneCuts, frameDiff,
           decodeAudio, detectScenesInFile, encodeWav16k };
});
