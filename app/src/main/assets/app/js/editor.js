/* FreeCut Mobile — editor core: project model + ffmpeg export graph builder.
 * Pure JS (no DOM) so it can be unit-tested in Node and reused in the app.
 * The graph logic mirrors desktop FreeCut's ffmpeg_engine, simplified to a
 * single sequential video track + one music track + text overlays.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FCEditor = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  let _uid = 0;
  const uid = () => "c" + Date.now().toString(36) + "_" + (_uid++);

  // ---------------------------------------------------------------- model
  function newProject() {
    return {
      clips: [],            // {id, src, in, out, speed, volume, muted, filters}
      texts: [],            // {id, text, start, duration, position, fontSize, color, box}
      music: null,          // {src, volume}
    };
  }

  function newClip(src, duration) {
    return {
      id: uid(), src, in: 0, out: duration,
      speed: 1, volume: 1, muted: false,
      filters: { brightness: 0, contrast: 1, saturation: 1, grayscale: false },
    };
  }

  const clipDur = (c) => Math.max(0.05, (c.out - c.in) / Math.max(0.05, c.speed));

  /** A still picture on the timeline: shows for `dur` seconds, no source audio. */
  function newImageClip(src, dur) {
    const c = newClip(src, dur || 3);
    c.image = true;
    return c;
  }

  /** Sequential timeline: clip i starts where clip i-1 ends. Returns durations. */
  function layout(project) {
    let t = 0;
    const out = [];
    for (const c of project.clips) {
      const d = clipDur(c);
      out.push({ clip: c, start: t, end: t + d, dur: d });
      t += d;
    }
    return { items: out, total: t };
  }

  function splitClip(project, clipId, timelineTime) {
    const { items } = layout(project);
    const it = items.find((x) => x.clip.id === clipId);
    if (!it) return null;
    const rel = timelineTime - it.start;
    if (rel < 0.05 || it.dur - rel < 0.05) return null;
    const cutSource = it.clip.in + rel * it.clip.speed;
    const right = JSON.parse(JSON.stringify(it.clip));
    right.id = uid();
    right.in = cutSource;
    it.clip.out = cutSource;
    const idx = project.clips.findIndex((c) => c.id === clipId);
    project.clips.splice(idx + 1, 0, right);
    return right;
  }

  function removeClip(project, clipId) {
    const i = project.clips.findIndex((c) => c.id === clipId);
    if (i >= 0) project.clips.splice(i, 1);
  }

  function moveClip(project, clipId, toIndex) {
    const i = project.clips.findIndex((c) => c.id === clipId);
    if (i < 0) return;
    const [c] = project.clips.splice(i, 1);
    project.clips.splice(Math.max(0, Math.min(toIndex, project.clips.length)), 0, c);
  }

  function newText(start) {
    return {
      id: uid(), text: "Your text", start: Math.max(0, start || 0), duration: 3,
      position: "bottom-center", fontSize: 64, color: "white", box: true,
    };
  }

  const TEXT_POSITIONS = {
    "top-left":      ["(tw)/16",        "(th)*0.6"],
    "top-center":    ["(w-tw)/2",       "(th)*0.6"],
    "top-right":     ["w-tw-(tw)/16",   "(th)*0.6"],
    "middle-left":   ["(tw)/16",        "(h-th)/2"],
    "center":        ["(w-tw)/2",       "(h-th)/2"],
    "middle-right":  ["w-tw-(tw)/16",   "(h-th)/2"],
    "bottom-left":   ["(tw)/16",        "h-(th)*1.6"],
    "bottom-center": ["(w-tw)/2",       "h-(th)*1.6"],
    "bottom-right":  ["w-tw-(tw)/16",   "h-(th)*1.6"],
  };

  // ------------------------------------------------------------ drawtext
  /** Escape text for use inside an ffmpeg filter value (single-quoted). */
  function escText(s) {
    return String(s)
      .replace(/\\/g, "\\\\\\\\")
      .replace(/'/g, "\\\\'")
      .replace(/:/g, "\\:")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;")
      .replace(/\[/g, "\\[").replace(/\]/g, "\\]")
      .replace(/%/g, "\\%")
      .replace(/\n/g, " ");
  }

  /** "#ffe259" -> "0xffe259" (safe inside filter_complex); names pass through. */
  function ffColor(c) {
    return /^#([0-9a-fA-F]{6})/.test(c || "") ? "0x" + c.slice(1) : (c || "white");
  }

  // ------------------------------------------------------------ graph build
  const PRESETS = {
    draft:  { width: 854, height: 480, crf: 30, preset: "ultrafast", label: "Draft 480p (fastest)" },
    hd:     { width: 1280, height: 720, crf: 23, preset: "ultrafast", label: "HD 720p" },
    fhd:    { width: 1920, height: 1080, crf: 21, preset: "veryfast", label: "Full HD 1080p" },
    tiktok: { width: 1080, height: 1920, crf: 21, preset: "veryfast", label: "TikTok / Reels / Shorts — vertical 1080×1920" },
    square: { width: 1080, height: 1080, crf: 21, preset: "veryfast", label: "Instagram post — square 1080×1080" },
  };

  function atempoChain(speed) {
    // atempo supports 0.5..100 per stage; chain for extremes
    const parts = [];
    let s = speed;
    while (s > 2.0) { parts.push("atempo=2.0"); s /= 2.0; }
    while (s < 0.5) { parts.push("atempo=0.5"); s /= 0.5; }
    parts.push("atempo=" + s.toFixed(4));
    return parts.join(",");
  }

  /**
   * Build the ffmpeg argument list.
   * media: {srcName: {hasAudio:boolean}} — probed at import time.
   * Returns { args, inputNames, total } — inputNames order matches -i order.
   */
  function buildGraph(project, media, opts) {
    opts = opts || {};
    const preset = PRESETS[opts.preset || "hd"];
    const W = preset.width, H = preset.height, FPS = 30;
    const font = opts.fontFile || null; // null → text overlays skipped
    const filters = [];
    const inputNames = [];
    const clips = project.clips;
    if (!clips.length) throw new Error("Timeline is empty");

    const inputPre = [];   // extra ffmpeg input options per input (image loops)
    clips.forEach((c) => {
      inputNames.push(c.src);
      inputPre.push(c.image ? ["-loop", "1", "-t", clipDur(c).toFixed(3)] : []);
    });
    const musicIdx = project.music ? inputNames.length : -1;
    if (project.music) { inputNames.push(project.music.src); inputPre.push([]); }

    const vLabels = [], aLabels = [];
    clips.forEach((c, i) => {
      const f = c.filters || {};
      let v;
      if (c.image) {
        // still picture: input is already looped for the clip's timeline duration
        v = `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
          `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}`;
      } else {
        const dur = c.out - c.in;
        v = `[${i}:v]trim=start=${c.in.toFixed(3)}:end=${c.out.toFixed(3)},` +
          `setpts=(PTS-STARTPTS)/${c.speed.toFixed(4)}`;
        v += `,scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
          `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}`;
      }
      const eq = [];
      if (f.brightness) eq.push("brightness=" + Number(f.brightness).toFixed(3));
      if (f.contrast && f.contrast !== 1) eq.push("contrast=" + Number(f.contrast).toFixed(3));
      if (f.saturation && f.saturation !== 1) eq.push("saturation=" + Number(f.saturation).toFixed(3));
      if (eq.length) v += ",eq=" + eq.join(":");
      if (f.grayscale) v += ",hue=s=0";
      if (c.image) v += `,trim=0:${clipDur(c).toFixed(3)},setpts=PTS-STARTPTS`;
      v += ",format=yuv420p";
      v += `[v${i}]`;
      filters.push(v);

      const hasA = media[c.src] && media[c.src].hasAudio;
      let a;
      if (hasA && !c.muted) {
        a = `[${i}:a]atrim=start=${c.in.toFixed(3)}:end=${c.out.toFixed(3)},` +
          `asetpts=PTS-STARTPTS,${atempoChain(c.speed)},` +
          `volume=${Number(c.volume).toFixed(3)},aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`;
      } else {
        a = `anullsrc=r=44100:cl=stereo,atrim=0:${clipDur(c).toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`;
      }
      filters.push(a);
      vLabels.push(`[v${i}]`);
      aLabels.push(`[a${i}]`);
    });

    let cv = "cv", ca = "ca";
    if (clips.length === 1) {
      filters.push(`${vLabels[0]}null[${cv}]`);
      filters.push(`${aLabels[0]}anull[${ca}]`);
    } else {
      const inter = vLabels.map((v, i) => v + aLabels[i]).join("");
      filters.push(`${inter}concat=n=${clips.length}:v=1:a=1[${cv}][${ca}]`);
    }

    // text overlays (timeline-time based) — skipped if no font file available.
    // Text is passed via textfile= (capN.txt written next to the inputs):
    // this avoids ALL filtergraph quoting/escaping issues and keeps
    // newlines + non-Latin scripts (Arabic, CJK, emoji-safe bytes) intact.
    const texts = font ? project.texts : [];
    const textFiles = {};
    texts.forEach((t, i) => {
      const fn = "cap" + i + ".txt";
      textFiles[fn] = t.text;
      const [x, y] = TEXT_POSITIONS[t.position] || TEXT_POSITIONS["center"];
      const end = t.start + t.duration;
      const fs = Math.round((t.fontSize / 1080) * H);
      let d = `drawtext=fontfile='${font}':textfile='${fn}':` +
        `fontsize=${fs}:fontcolor=${ffColor(t.color)}:` +
        `x=${x}:y=${y}:line_spacing=6:` +
        `borderw=2:bordercolor=black`;
      if (t.box) d += ":box=1:boxcolor=black@0.5:boxborderw=12";
      d += `:enable='between(t,${t.start.toFixed(3)},${end.toFixed(3)})'`;
      const next = i === texts.length - 1 ? "fv0" : "ft" + i;
      filters.push(`[${cv}]${d}[${next}]`);
      cv = next;
    });
    if (cv === "cv") filters.push(`[cv]null[fv0]`);
    const vOut = "fv0";

    let aOut = ca;
    if (project.music) {
      const { total } = layout(project);
      filters.push(`[${musicIdx}:a]volume=${Number(project.music.volume).toFixed(3)}` +
        `,aformat=sample_rates=44100:channel_layouts=stereo[ma]`);
      filters.push(`[ma]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS[mat]`);
      filters.push(`[${ca}][mat]amix=inputs=2:duration=first:dropout_transition=0` +
        `,alimiter=limit=0.95[fa0]`);
      aOut = "fa0";
    }

    const args = [];
    inputNames.forEach((n, i) => args.push(...inputPre[i], "-i", n));
    args.push("-filter_complex", filters.join(";"));
    args.push("-map", `[${vOut}]`, "-map", `[${aOut}]`);
    args.push("-c:v", "libx264", "-preset", preset.preset, "-crf", String(preset.crf),
      "-pix_fmt", "yuv420p", "-r", String(FPS));
    args.push("-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart");
    args.push("-t", layout(project).total.toFixed(3));
    args.push("out.mp4");
    return { args, inputNames, total: layout(project).total,
             textFiles, textsSkipped: font ? 0 : project.texts.length };
  }

  return {
    newProject, newClip, newImageClip, newText, layout, splitClip, removeClip, moveClip,
    clipDur, buildGraph, PRESETS, TEXT_POSITIONS, escText, ffColor, atempoChain,
  };
});
