/* FreeCut Mobile — ffmpeg.wasm wrapper (@ffmpeg/ffmpeg 0.11 API).
 * Loads ffmpeg from CDN on first export, caches it (browser Cache API via the
 * service worker), probes media, and runs exports with progress callbacks.
 */
(function (root) {
  "use strict";

  const WRAPPER_URL = "https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js";
  const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.11.0/dist";
  const CORE_JS = CORE_BASE + "/ffmpeg-core.js";

  let _ffmpeg = null;
  let _loading = null;

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not download the video engine. Check internet and try again."));
      document.head.appendChild(s);
    });
  }

  async function fileToBytes(file) {
    return new Uint8Array(await file.arrayBuffer());
  }

  class FFRunner {
    async ensureLoaded() {
      if (_ffmpeg) return _ffmpeg;
      if (_loading) return _loading;
      _loading = (async () => {
        if (!root.FFmpeg) await loadScript(WRAPPER_URL);
        if (!root.FFmpeg || typeof root.FFmpeg.createFFmpeg !== "function")
          throw new Error("Video engine loaded but is incompatible. Please update the app.");
        const ffmpeg = root.FFmpeg.createFFmpeg({ log: false, corePath: CORE_JS });
        await ffmpeg.load();
        _ffmpeg = ffmpeg;
        return ffmpeg;
      })();
      try {
        return await _loading;
      } catch (e) {
        _loading = null;
        if (/SharedArrayBuffer/.test(String(e && e.message || e))) {
          throw new Error("This browser tab doesn't allow the video engine. In the FreeCut Android app it works — or use a host with cross-origin isolation.");
        }
        throw e;
      }
    }

    /** Probe a File: returns {duration, hasAudio, width, height}. */
    async probe(file, name) {
      const ff = await this.ensureLoaded();
      const data = await fileToBytes(file);
      ff.FS("writeFile", name, data);
      const logs = [];
      ff.setLogger((m) => logs.push(m.message || String(m)));
      try { await ff.run("-hide_banner", "-i", name); } catch (e) { /* exits nonzero */ }
      ff.setLogger(() => {});
      const text = logs.join("\n");
      const dm = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
      const duration = dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + (+dm[3]) : 0;
      const vm = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(text);
      return {
        duration,
        hasAudio: /Audio:/.test(text),
        width: vm ? +vm[1] : 0,
        height: vm ? +vm[2] : 0,
      };
    }

    async writeInput(name, file) {
      const ff = await this.ensureLoaded();
      ff.FS("writeFile", name, file instanceof Uint8Array ? file : await fileToBytes(file));
    }

    /** Run the export graph; onProgress(0..1). Returns MP4 bytes. */
    async exportMp4(args, total, onProgress) {
      const ff = await this.ensureLoaded();
      ff.setProgress((p) => {
        if (!onProgress) return;
        if (p && typeof p.ratio === "number" && isFinite(p.ratio) && p.ratio >= 0) {
          onProgress(Math.min(0.99, p.ratio));
        } else if (p && typeof p.time === "number" && total > 0) {
          onProgress(Math.min(0.99, p.time / 1000000 / total));
        }
      });
      let err = null;
      try {
        await ff.run(...args);
      } catch (e) { err = e; }
      ff.setProgress(() => {});
      if (err) throw new Error("Export failed (" + (err.message || err) + ")");
      const data = ff.FS("readFile", "out.mp4");
      if (!data || !data.length) throw new Error("Export produced no output");
      return data;
    }

    async cleanup(names) {
      if (!_ffmpeg) return;
      for (const n of names) {
        try { _ffmpeg.FS("unlink", n); } catch (e) {}
      }
    }
  }

  root.FFWrap = { FFRunner };
})(typeof self !== "undefined" ? self : this);
