/* FreeCut Mobile — UI logic. */
(function () {
  "use strict";
  const E = window.FCEditor;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ state
  const project = E.newProject();
  const media = new Map();       // srcName -> {file,url,duration,hasAudio,w,h,kind}
  let srcCounter = 0;
  let selectedClipId = null;
  let playhead = 0;
  let playing = false;
  let undoStack = [];
  let redoStack = [];
  let undoTimer = null;
  const runner = new window.FFWrap.FFRunner();

  const player = $("player");
  const textLayer = $("textLayer");
  const seek = $("seek");

  // ------------------------------------------------------------ undo
  function snapshot() { return JSON.stringify(project); }
  function pushUndo() {
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
      undoStack.push(snapshot());
      if (undoStack.length > 60) undoStack.shift();
      redoStack = [];
    }, 350);
  }
  function restore(json) {
    const p = JSON.parse(json);
    project.clips = p.clips; project.texts = p.texts; project.music = p.music;
    if (selectedClipId && !project.clips.find((c) => c.id === selectedClipId)) {
      selectedClipId = null;
    }
    renderAll();
  }
  $("undoBtn").onclick = () => {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
  };

  // ------------------------------------------------------------ helpers
  const fmt = (s) => {
    s = Math.max(0, s || 0);
    const m = Math.floor(s / 60), ss = (s % 60).toFixed(1).padStart(4, "0");
    return m + ":" + ss;
  };
  const ext = (n) => (n.split(".").pop() || "mp4").toLowerCase().replace(/[^\w]/g, "");

  function cssFilter(f) {
    // eq brightness -1..1 → CSS 0..2 (1 = neutral); contrast/sat similar
    const b = 1 + (f.brightness || 0);
    const parts = [`brightness(${b.toFixed(3)})`];
    if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
    if (f.saturation !== 1) parts.push(`saturate(${f.saturation})`);
    if (f.grayscale) parts.push("grayscale(1)");
    return parts.join(" ");
  }

  // ------------------------------------------------------------ media import
  function readDuration(url, kind) {
    return new Promise((res) => {
      const el = document.createElement(kind === "audio" ? "audio" : "video");
      el.preload = "metadata";
      el.onloadedmetadata = () => res(el.duration || 0);
      el.onerror = () => res(0);
      el.src = url;
    });
  }

  async function addMediaFiles(files, kind) {
    for (const file of files) {
      const isImage = kind !== "audio" && (file.type || "").startsWith("image/");
      const name = "m" + (++srcCounter) + "." + ext(file.name);
      const url = URL.createObjectURL(file);
      const duration = isImage ? 3600 : await readDuration(url, kind); // pictures can stretch to any length
      media.set(name, {
        file, url, duration, kind: isImage ? "image" : kind,
        hasAudio: kind === "audio" ? true : isImage ? false : null, // videos probed at export
        name: file.name,
      });
      if (kind === "audio") {
        project.music = { src: name, volume: 1 };
      } else if (isImage) {
        const clip = E.newImageClip(name, 3);
        project.clips.push(clip);
        selectedClipId = clip.id;
      } else {
        const clip = E.newClip(name, duration || 5);
        project.clips.push(clip);
        selectedClipId = clip.id;
      }
      pushUndo();
    }
    renderAll();
  }

  $("addVideoBtn").onclick = () => $("videoInput").click();
  $("addMusicBtn").onclick = () => $("musicInput").click();
  $("videoInput").onchange = (e) => { addMediaFiles([...e.target.files], "video"); e.target.value = ""; };
  $("musicInput").onchange = (e) => { addMediaFiles([...e.target.files], "audio"); e.target.value = ""; };

  // ------------------------------------------------------------ preview
  function itemAt(t) {
    const L = E.layout(project);
    return L.items.find((x) => t < x.end) || L.items[L.items.length - 1] || null;
  }

  let previewSrc = null;
  let imageClock = null, imageClockClip = null;
  function stopImageClock() {
    if (imageClock) { clearInterval(imageClock); imageClock = null; imageClockClip = null; }
  }
  // pictures have no <video> clock — advance the playhead with a timer instead
  function startImageClock(it) {
    if (imageClockClip === it.clip.id) return;
    stopImageClock();
    imageClockClip = it.clip.id;
    imageClock = setInterval(() => {
      if (!playing) { stopImageClock(); return; }
      playhead += 0.1;
      const L = E.layout(project);
      if (playhead >= it.end - 0.01) {
        const next = L.items.find((x) => x.start >= it.end - 1e-4);
        stopImageClock();
        if (next) {
          playhead = next.start;
          previewSrc = null;
          renderFrame();
          player.play().catch(() => {});
        } else {
          playhead = L.total;
          pause();
        }
      }
      $("timeLbl").textContent = fmt(playhead) + " / " + fmt(L.total);
      seek.value = Math.round((playhead / Math.max(0.01, L.total)) * 1000);
      renderTextOverlay();
    }, 100);
  }

  function renderFrame() {
    const L = E.layout(project);
    $("emptyHint").style.display = project.clips.length ? "none" : "flex";
    $("timeLbl").textContent = fmt(playhead) + " / " + fmt(L.total);
    seek.value = L.total ? Math.round((playhead / L.total) * 1000) : 0;
    renderTextOverlay();

    const it = itemAt(playhead);
    if (!it) { player.removeAttribute("src"); previewSrc = null; stopImageClock(); return; }
    const c = it.clip;
    const m = media.get(c.src);
    if (!m) return;

    if (c.image) {
      player.pause();
      player.classList.add("hidden");
      const img = $("imgPreview");
      img.classList.remove("hidden");
      if (img.dataset.src !== c.src) { img.src = m.url; img.dataset.src = c.src; }
      img.style.filter = cssFilter(c.filters);
      if (playing) startImageClock(it); else stopImageClock();
      return;
    }
    $("imgPreview").classList.add("hidden");
    player.classList.remove("hidden");
    stopImageClock();
    if (previewSrc !== c.src) {
      player.src = m.url;
      previewSrc = c.src;
    }
    const srcTime = c.in + Math.max(0, playhead - it.start) * c.speed;
    if (Math.abs(player.currentTime - srcTime) > 0.35) player.currentTime = srcTime;
    player.playbackRate = c.speed;
    player.muted = c.muted;
    player.volume = Math.min(1, Math.max(0, c.volume));
    player.style.filter = cssFilter(c.filters);
  }

  function renderTextOverlay() {
    const H = $("preview").clientHeight || 200;
    let html = "";
    for (const t of project.texts) {
      if (playhead < t.start || playhead >= t.start + t.duration) continue;
      const fs = Math.max(10, (t.fontSize / 1080) * H);
      const pos = t.position || "bottom-center";
      let style = `font-size:${fs.toFixed(0)}px;color:${t.color || "white"};`;
      if (pos.includes("top")) style += "top:6%;";
      else if (pos.includes("bottom")) style += "bottom:8%;";
      else style += "top:50%;";
      if (pos.endsWith("left")) { style += "left:3%;text-align:left;"; if (pos.startsWith("middle")) style += "transform:translateY(-50%);"; }
      else if (pos.endsWith("right")) { style += "right:3%;text-align:right;"; if (pos.startsWith("middle")) style += "transform:translateY(-50%);"; }
      else { style += "left:50%;"; style += pos.startsWith("middle") || pos === "center" ? "transform:translate(-50%,-50%);" : "transform:translateX(-50%);"; }
      html += `<div class="cap ${t.box ? "box" : ""}" style="${style}">${escapeHtml(t.text)}</div>`;
    }
    textLayer.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // playback
  $("playBtn").onclick = () => { playing ? pause() : play(); };
  function play() {
    if (!project.clips.length) return;
    const L = E.layout(project);
    if (playhead >= L.total - 0.05) playhead = 0;
    playing = true;
    $("playBtn").textContent = "⏸";
    renderFrame();
    player.play().catch(() => {});
  }
  function pause() {
    playing = false;
    $("playBtn").textContent = "▶";
    stopImageClock();
    player.pause();
    renderFrame();
  }

  player.addEventListener("timeupdate", () => {
    if (!playing) return;
    const it = itemAt(playhead);
    if (!it) return pause();
    const c = it.clip;
    playhead = it.start + (player.currentTime - c.in) / c.speed;
    if (player.currentTime >= c.out - 0.03) {
      const L = E.layout(project);
      const next = L.items.find((x) => x.start >= it.end - 1e-4);
      if (next) {
        playhead = next.start;
        previewSrc = null;      // force src switch
        renderFrame();
        player.play().catch(() => {});
      } else {
        playhead = L.total;
        pause();
      }
    }
    $("timeLbl").textContent = fmt(playhead) + " / " + fmt(E.layout(project).total);
    seek.value = Math.round((playhead / Math.max(0.01, E.layout(project).total)) * 1000);
    renderTextOverlay();
  });

  seek.addEventListener("input", () => {
    const L = E.layout(project);
    playhead = (seek.value / 1000) * L.total;
    if (playing) { renderFrame(); player.play().catch(() => {}); }
    else renderFrame();
  });

  // ------------------------------------------------------------ timeline UI
  function renderTimeline() {
    const tl = $("tl");
    const L = E.layout(project);
    tl.innerHTML = "";
    if (!project.clips.length) {
      tl.innerHTML = '<div id="tlEmpty">Timeline is empty — add a video</div>';
      return;
    }
    for (const it of L.items) {
      const c = it.clip;
      const m = media.get(c.src);
      const card = document.createElement("div");
      card.className = "clip" + (c.id === selectedClipId ? " sel" : "");
      card.style.width = Math.max(84, Math.min(240, it.dur * 55)) + "px";
      card.dataset.cid = c.id;
      const badges = [];
      if (c.speed !== 1) badges.push(c.speed + "×");
      if (c.muted) badges.push("🔇");
      card.innerHTML =
        `<div class="nm">${escapeHtml(m ? m.name : c.src)}</div>` +
        `<div class="du">${fmt(it.dur)}</div>` +
        (badges.length ? `<div class="badge">${badges.join(" ")}</div>` : "") +
        `<div class="handle l"></div><div class="handle r"></div>`;
      tl.appendChild(card);
      wireClipCard(card, c);
    }
  }

  function wireClipCard(card, clip) {
    let mode = null, startX = 0, origIn = 0, origOut = 0, moved = false;

    card.addEventListener("pointerdown", (ev) => {
      card.setPointerCapture(ev.pointerId);
      startX = ev.clientX;
      moved = false;
      origIn = clip.in; origOut = clip.out;
      if (ev.target.classList.contains("handle")) {
        mode = ev.target.classList.contains("l") ? "trimL" : "trimR";
      } else {
        mode = "maybe-drag";
      }
      selectClip(clip.id);
    });

    card.addEventListener("pointermove", (ev) => {
      if (!mode) return;
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 6) moved = true;
      if (mode === "maybe-drag" && Math.abs(dx) > 14) mode = "drag";
      if (mode === "trimL" || mode === "trimR") {
        const m = media.get(clip.src);
        const srcDur = m ? m.duration : clip.out;
        const secPerPx = E.clipDur(clip) / card.clientWidth * clip.speed;
        const ds = dx * secPerPx;
        if (mode === "trimL") {
          clip.in = Math.max(0, Math.min(origIn + ds, clip.out - 0.2 / clip.speed));
        } else {
          clip.out = Math.min(srcDur, Math.max(origOut + ds, clip.in + 0.2 / clip.speed));
        }
        renderTimeline();
        renderFrame();
      } else if (mode === "drag") {
        card.style.opacity = "0.6";
        const cards = [...document.querySelectorAll(".clip")];
        const over = cards.find((el) => {
          const r = el.getBoundingClientRect();
          return ev.clientX >= r.left && ev.clientX <= r.right;
        });
        if (over && over.dataset.cid !== clip.id) {
          const toIdx = project.clips.findIndex((c) => c.id === over.dataset.cid);
          const fromIdx = project.clips.findIndex((c) => c.id === clip.id);
          if (toIdx !== fromIdx) {
            const [c] = project.clips.splice(fromIdx, 1);
            project.clips.splice(toIdx, 0, c);
            startX = ev.clientX;
            renderTimeline();
          }
        }
      }
    });

    card.addEventListener("pointerup", (ev) => {
      if (mode === "trimL" || mode === "trimR") { pushUndo(); renderAll(); }
      else if (mode === "drag") { card.style.opacity = ""; pushUndo(); renderAll(); }
      else if (!moved) selectClip(clip.id);
      mode = null;
    });
    card.addEventListener("pointercancel", () => { mode = null; card.style.opacity = ""; });
  }

  function selectClip(id) {
    selectedClipId = id;
    const L = E.layout(project);
    const it = L.items.find((x) => x.clip.id === id);
    if (it) playhead = it.start + 0.01;
    renderAll();
  }

  // toolbar actions
  $("splitBtn").onclick = () => {
    const it = itemAt(playhead);
    if (!it) return;
    if (E.splitClip(project, it.clip.id, playhead)) { pushUndo(); renderAll(); }
  };
  $("delBtn").onclick = () => {
    if (!selectedClipId) return;
    E.removeClip(project, selectedClipId);
    selectedClipId = null;
    pushUndo(); renderAll();
  };
  $("dupBtn").onclick = () => {
    const c = project.clips.find((x) => x.id === selectedClipId);
    if (!c) return;
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = "x" + Math.random().toString(36).slice(2, 9);
    const i = project.clips.findIndex((x) => x.id === c.id);
    project.clips.splice(i + 1, 0, copy);
    selectedClipId = copy.id;
    pushUndo(); renderAll();
  };

  // ------------------------------------------------------------ bottom sheet
  let sheetMode = "clip"; // clip | text | music | auto | ai
  function renderSheet() {
    $("sheetTitle").textContent =
      sheetMode === "text" ? "Text" : sheetMode === "music" ? "Music" :
      sheetMode === "auto" ? "Auto Cut" : sheetMode === "ai" ? "AI Assistant" : "Clip";
    const body = $("sheetBody");
    if (sheetMode === "text") return renderTextSheet(body);
    if (sheetMode === "music") return renderMusicSheet(body);
    if (sheetMode === "auto") return renderAutoSheet(body);
    if (sheetMode === "ai") return renderAISheet(body);
    const c = project.clips.find((x) => x.id === selectedClipId);
    if (!c) {
      body.innerHTML = '<div class="hint">Select a clip to edit — or add a video to begin</div>';
      return;
    }
    body.innerHTML = `
      <div class="ctl"><label>Speed</label>
        <input type="range" id="s_speed" min="0.25" max="4" step="0.25" value="${c.speed}">
        <span class="val" id="v_speed">${c.speed}×</span></div>
      <div class="ctl"><label>Volume</label>
        <input type="range" id="s_vol" min="0" max="2" step="0.05" value="${c.volume}">
        <span class="val" id="v_vol">${Math.round(c.volume * 100)}%</span></div>
      <div class="chips">
        <button class="chip ${c.muted ? "on" : ""}" id="s_mute">🔇 Mute</button>
        <button class="chip ${c.filters.grayscale ? "on" : ""}" id="s_bw">◐ B&W</button>
        <button class="chip" id="s_reset">Reset</button>
      </div>
      <div class="ctl"><label>Bright</label>
        <input type="range" id="s_bri" min="-0.5" max="0.5" step="0.02" value="${c.filters.brightness}">
        <span class="val" id="v_bri">${c.filters.brightness.toFixed(2)}</span></div>
      <div class="ctl"><label>Contrast</label>
        <input type="range" id="s_con" min="0.5" max="2" step="0.05" value="${c.filters.contrast}">
        <span class="val" id="v_con">${c.filters.contrast.toFixed(2)}</span></div>
      <div class="ctl"><label>Saturate</label>
        <input type="range" id="s_sat" min="0" max="3" step="0.1" value="${c.filters.saturation}">
        <span class="val" id="v_sat">${c.filters.saturation.toFixed(1)}</span></div>`;
    const upd = () => {
      c.speed = parseFloat($("s_speed").value);
      c.volume = parseFloat($("s_vol").value);
      c.filters.brightness = parseFloat($("s_bri").value);
      c.filters.contrast = parseFloat($("s_con").value);
      c.filters.saturation = parseFloat($("s_sat").value);
      $("v_speed").textContent = c.speed + "×";
      $("v_vol").textContent = Math.round(c.volume * 100) + "%";
      $("v_bri").textContent = c.filters.brightness.toFixed(2);
      $("v_con").textContent = c.filters.contrast.toFixed(2);
      $("v_sat").textContent = c.filters.saturation.toFixed(1);
      pushUndo(); renderTimeline(); renderFrame();
    };
    ["s_speed", "s_vol", "s_bri", "s_con", "s_sat"].forEach((id) => ($(id).oninput = upd));
    $("s_mute").onclick = () => { c.muted = !c.muted; pushUndo(); renderAll(); };
    $("s_bw").onclick = () => { c.filters.grayscale = !c.filters.grayscale; pushUndo(); renderAll(); };
    $("s_reset").onclick = () => {
      c.speed = 1; c.volume = 1; c.muted = false;
      c.filters = { brightness: 0, contrast: 1, saturation: 1, grayscale: false };
      pushUndo(); renderAll();
    };
  }

  $("textBtn").onclick = () => { sheetMode = sheetMode === "text" ? "clip" : "text"; renderSheet(); };
  $("autoBtn").onclick = () => { sheetMode = sheetMode === "auto" ? "clip" : "auto"; renderSheet(); };
  $("aiBtn").onclick = () => { sheetMode = sheetMode === "ai" ? "clip" : "ai"; renderSheet(); };
  $("addMusicBtn").addEventListener("contextmenu", (e) => e.preventDefault());

  function renderTextSheet(body) {
    let rows = "";
    for (const t of project.texts) {
      rows += `<div class="titem" data-tid="${t.id}">
        <div class="tx">${escapeHtml(t.text.slice(0, 30))}</div>
        <button class="delT">🗑</button></div>`;
    }
    body.innerHTML = `
      <div class="chips"><button class="chip" id="t_add">＋ Add text</button>
      <button class="chip" id="t_back">← Back to clip</button></div>
      ${rows || '<div class="hint">No text yet</div>'}`;
    $("t_add").onclick = () => openTextModal(null);
    $("t_back").onclick = () => { sheetMode = "clip"; renderSheet(); };
    body.querySelectorAll(".titem").forEach((el) => {
      const t = project.texts.find((x) => x.id === el.dataset.tid);
      el.querySelector(".tx").onclick = () => openTextModal(t);
      el.querySelector(".delT").onclick = () => {
        project.texts = project.texts.filter((x) => x.id !== t.id);
        pushUndo(); renderAll();
      };
    });
  }

  function renderMusicSheet(body) {
    const m = project.music;
    if (!m) {
      body.innerHTML = '<div class="hint">No music — tap ♫Music to add a track</div>';
      return;
    }
    const meta = media.get(m.src);
    body.innerHTML = `
      <div class="ctl"><label>Music</label><span style="flex:1;color:var(--text)">${escapeHtml(meta ? meta.name : m.src)}</span>
      <button class="miniBtn" id="m_del">🗑</button></div>
      <div class="ctl"><label>Volume</label>
        <input type="range" id="m_vol" min="0" max="2" step="0.05" value="${m.volume}">
        <span class="val" id="v_mvol">${Math.round(m.volume * 100)}%</span></div>`;
    $("m_vol").oninput = () => {
      m.volume = parseFloat($("m_vol").value);
      $("v_mvol").textContent = Math.round(m.volume * 100) + "%";
      pushUndo();
    };
    $("m_del").onclick = () => { project.music = null; pushUndo(); renderAll(); };
  }

  // long-press music button toggles music sheet (simple: tap adds, hold not needed — use sheetMode when music exists via a chip)
  $("addMusicBtn").onclick = () => {
    if (project.music && sheetMode !== "music") { sheetMode = "music"; renderSheet(); }
    else if (project.music) { sheetMode = "clip"; renderSheet(); }
    else $("musicInput").click();
  };

  // ------------------------------------------------------------ text modal
  const POSITIONS = ["top-left","top-center","top-right","middle-left","center","middle-right","bottom-left","bottom-center","bottom-right"];
  function openTextModal(t) {
    const isNew = !t;
    if (isNew) {
      t = E.newText(Math.min(playhead, Math.max(0, E.layout(project).total - 0.5)));
      t.text = "";
    }
    const colors = ["#ffffff", "#ffe259", "#19c2b8", "#ff6b81", "#8aff8a", "#111111"];
    const POS_GLYPHS = { "top-left":"↖","top-center":"↑","top-right":"↗","middle-left":"←","center":"●","middle-right":"→","bottom-left":"↙","bottom-center":"↓","bottom-right":"↘" };
    openModal(`
      <h2>${isNew ? "Add text" : "Edit text"}</h2>
      <textarea id="tm_text" rows="3" placeholder="Type your text…">${escapeHtml(t.text)}</textarea>
      <div class="posgrid" id="tm_pos">${POSITIONS.map((p) =>
        `<button class="chip ${p === t.position ? "on" : ""}" data-p="${p}">${POS_GLYPHS[p]}</button>`).join("")}</div>
      <div class="chips" id="tm_color">${colors.map((c) =>
        `<button class="chip ${c === t.color ? "on" : ""}" data-c="${c}" style="color:${c}">A</button>`).join("")}</div>
      <div class="chips"><button class="chip ${t.box ? "on" : ""}" id="tm_box">Box</button></div>
      <div class="ctl"><label>Start</label><input type="range" id="tm_start" min="0"
        max="${Math.max(1, E.layout(project).total)}" step="0.1" value="${t.start}">
        <span class="val" id="v_tmstart">${fmt(t.start)}</span></div>
      <div class="ctl"><label>Length</label><input type="range" id="tm_dur" min="0.5"
        max="${Math.max(2, E.layout(project).total)}" step="0.5" value="${t.duration}">
        <span class="val" id="v_tmdur">${t.duration}s</span></div>
      <button class="btn" id="tm_ok">${isNew ? "Add" : "Save"}</button>`);
    $("tm_pos").querySelectorAll(".chip").forEach((el) => (el.onclick = () => {
      t.position = el.dataset.p;
      $("tm_pos").querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === el));
    }));
    $("tm_color").querySelectorAll(".chip").forEach((el) => (el.onclick = () => {
      t.color = el.dataset.c;
      $("tm_color").querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === el));
    }));
    $("tm_box").onclick = () => { t.box = !t.box; $("tm_box").classList.toggle("on", t.box); };
    $("tm_start").oninput = () => { t.start = parseFloat($("tm_start").value); $("v_tmstart").textContent = fmt(t.start); };
    $("tm_dur").oninput = () => { t.duration = parseFloat($("tm_dur").value); $("v_tmdur").textContent = t.duration + "s"; };
    $("tm_ok").onclick = () => {
      t.text = $("tm_text").value.trim();
      if (t.text) {
        if (isNew) project.texts.push(t);
        pushUndo();
      }
      closeModal(); renderAll();
    };
  }

  // ------------------------------------------------------------ auto cut
  const audioCache = new Map(); // src -> {samples, sampleRate, duration}
  async function ensureAudio(src) {
    if (!audioCache.has(src)) {
      const m = media.get(src);
      audioCache.set(src, await window.FCAuto.decodeAudio(m.file));
    }
    return audioCache.get(src);
  }

  async function cutSilences(threshold, minDur, onStep) {
    const newClips = [];
    let removed = 0;
    for (const clip of project.clips) {
      const m = media.get(clip.src);
      if (!m) { newClips.push(clip); continue; }
      if (onStep) onStep("Analyzing " + (m.name || clip.src) + "…");
      const a = await ensureAudio(clip.src);
      const sils = window.FCAuto.detectSilences(a.samples, a.sampleRate,
        { threshold, minDur });
      const keeps = window.FCAuto.keepRanges(clip.in, clip.out, sils);
      if (!keeps.length || (keeps.length === 1 &&
          Math.abs(keeps[0].start - clip.in) < 0.05 && Math.abs(keeps[0].end - clip.out) < 0.05)) {
        newClips.push(clip); continue;
      }
      removed += (clip.out - clip.in) - keeps.reduce((s, k) => s + (k.end - k.start), 0);
      for (const k of keeps) {
        const c = JSON.parse(JSON.stringify(clip));
        c.id = "x" + Math.random().toString(36).slice(2, 9);
        c.in = k.start; c.out = k.end;
        newClips.push(c);
      }
    }
    project.clips = newClips;
    if (selectedClipId && !project.clips.find((c) => c.id === selectedClipId)) selectedClipId = null;
    return removed;
  }

  async function splitScenes(onStep) {
    const newClips = [];
    let cuts = 0;
    for (const clip of project.clips) {
      const m = media.get(clip.src);
      if (!m || m.kind === "audio") { newClips.push(clip); continue; }
      if (onStep) onStep("Scanning " + (m.name || clip.src) + "…");
      const { cuts: sceneCuts } = await window.FCAuto.detectScenesInFile(
        m.url, clip.out, 0.5, null);
      const inner = sceneCuts.filter((t) => t > clip.in + 0.3 && t < clip.out - 0.3);
      let cur = clip.in;
      for (const p of inner.concat([clip.out])) {
        const c = JSON.parse(JSON.stringify(clip));
        c.id = "x" + Math.random().toString(36).slice(2, 9);
        c.in = cur; c.out = p; cur = p;
        newClips.push(c);
        cuts++;
      }
    }
    project.clips = newClips;
    if (selectedClipId && !project.clips.find((c) => c.id === selectedClipId)) selectedClipId = null;
    return cuts;
  }

  function renderAutoSheet(body) {
    body.innerHTML = `
      <div class="chips"><button class="chip" id="au_back">← Back to clip</button></div>
      <div class="ctl"><label>Sensitivity</label>
        <input type="range" id="au_thr" min="0.01" max="0.06" step="0.005" value="0.025">
        <span class="val" id="au_thrv">med</span></div>
      <div class="ctl"><label>Min silence</label>
        <input type="range" id="au_min" min="0.3" max="3" step="0.1" value="0.6">
        <span class="val" id="au_minv">0.6s</span></div>
      <div class="chips">
        <button class="chip" id="au_silence">🔇✂ Remove silences</button>
        <button class="chip" id="au_scenes">🎬 Split at scenes</button>
      </div>
      <div class="note" id="au_status">Everything runs on your phone — no upload.</div>`;
    $("au_thr").oninput = () => ($("au_thrv").textContent =
      (+$("au_thr").value < 0.02 ? "low" : +$("au_thr").value > 0.045 ? "high" : "med"));
    $("au_min").oninput = () => ($("au_minv").textContent = $("au_min").value + "s");
    $("au_back").onclick = () => { sheetMode = "clip"; renderSheet(); };
    $("au_silence").onclick = async () => {
      if (!project.clips.length) return;
      const st = $("au_status");
      st.textContent = "Analyzing audio…";
      try {
        const removed = await cutSilences(+$("au_thr").value, +$("au_min").value,
          (s) => (st.textContent = s));
        pushUndo(); renderAll(); sheetMode = "auto"; renderSheet();
        $("au_status").textContent = removed > 0.1
          ? "Done — removed " + removed.toFixed(1) + "s of silence."
          : "No silences found (try higher sensitivity).";
      } catch (e) { st.textContent = "Failed: " + e.message; }
    };
    $("au_scenes").onclick = async () => {
      if (!project.clips.length) return;
      const st = $("au_status");
      st.textContent = "Scanning frames…";
      try {
        const n = await splitScenes((s) => (st.textContent = s));
        pushUndo(); renderAll(); sheetMode = "auto"; renderSheet();
        $("au_status").textContent = n > 1 ? "Done — cut into " + n + " pieces."
          : "No scene changes found.";
      } catch (e) { st.textContent = "Failed: " + e.message; }
    };
  }

  // ------------------------------------------------------------ AI
  function renderAISheet(body) {
    const s = window.FCAI.loadSettings();
    body.innerHTML = `
      <div class="chips">
        <button class="chip" id="ai_back">← Back to clip</button>
        <button class="chip" id="ai_settings">⚙ AI settings</button>
        <button class="chip" id="ai_captions">💬 Auto-captions</button>
      </div>
      <textarea id="ai_task" rows="3" placeholder="Tell FreeCut what to do, e.g. &quot;remove the silences and speed everything up 2×&quot;"></textarea>
      <button class="btn" id="ai_run">✨ Run task</button>
      <div class="note" id="ai_status">${s.key
        ? "Ready — using " + (s.provider === "groq" ? "Groq" : "Gemini") + ". The AI only receives text; your video never leaves the phone."
        : "First tap ⚙ AI settings and add a free API key."}</div>`;
    $("ai_back").onclick = () => { sheetMode = "clip"; renderSheet(); };
    $("ai_settings").onclick = openAISettings;
    $("ai_run").onclick = runAITask;
    $("ai_captions").onclick = runCaptions;
  }

  function openAISettings() {
    const s = window.FCAI.loadSettings();
    const prov = s.provider || "gemini";
    openModal(`
      <h2>AI settings</h2>
      <div class="chips">
        <button class="chip ${prov === "gemini" ? "on" : ""}" data-pr="gemini">Gemini (Google)</button>
        <button class="chip ${prov === "groq" ? "on" : ""}" data-pr="groq">Groq</button>
      </div>
      <div class="note" id="ai_link">Free key: aistudio.google.com → "Get API key" (no card needed)</div>
      <input type="password" id="ai_key" placeholder="Paste your API key here" value="${s.key || ""}"
        style="width:100%;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:12px;font-size:15px;margin-bottom:12px">
      <button class="btn" id="ai_save" style="width:100%">Save</button>`);
    let chosen = prov;
    document.querySelectorAll("#modalCard .chip[data-pr]").forEach((el) => (el.onclick = () => {
      chosen = el.dataset.pr;
      document.querySelectorAll("#modalCard .chip[data-pr]").forEach((x) => x.classList.toggle("on", x === el));
      $("ai_link").textContent = chosen === "gemini"
        ? "Free key: aistudio.google.com → \"Get API key\" (no card needed)"
        : "Free key: console.groq.com → API Keys (also needed for auto-captions)";
    }));
    $("ai_save").onclick = () => {
      window.FCAI.saveSettings({ provider: chosen, key: $("ai_key").value.trim() });
      closeModal(); renderSheet();
    };
  }

  async function runAITask() {
    const st = $("ai_status");
    const text = $("ai_task").value.trim();
    if (!text) { st.textContent = "Type a task first."; return; }
    const settings = window.FCAI.loadSettings();
    if (!settings.key) { openAISettings(); return; }
    st.textContent = "Thinking…";
    try {
      const { actions } = await window.FCAI.askActions(settings, project, E.layout, text);
      if (!actions.length) {
        st.textContent = "The AI didn't find anything to do — try rephrasing.";
        return;
      }
      const { deferred, applied } = window.FCAI.applySyncActions(project, E, actions);
      for (const d of deferred) {
        if (d.do === "remove_silences") {
          st.textContent = "Removing silences…";
          await cutSilences(0.025, 0.6, (s) => (st.textContent = s));
        } else if (d.do === "split_scenes") {
          st.textContent = "Splitting at scenes…";
          await splitScenes((s) => (st.textContent = s));
        }
      }
      pushUndo(); renderAll();
      sheetMode = "ai"; renderSheet();
      $("ai_status").textContent = "Done — applied " + (applied + deferred.length) + " action(s).";
    } catch (e) {
      st.textContent = "AI failed: " + e.message;
    }
  }

  async function runCaptions() {
    const st = $("ai_status");
    const settings = window.FCAI.loadSettings();
    if (!project.clips.length) { st.textContent = "Add a video first."; return; }
    if (settings.provider !== "groq" || !settings.key) {
      st.textContent = "Auto-captions need a free Groq key — tap ⚙ AI settings, choose Groq, paste the key.";
      openAISettings();
      return;
    }
    try {
      const L = E.layout(project);
      let added = 0, failed = 0;
      for (const it of L.items) {
        const clip = it.clip;
        if (clip.image) continue; // pictures have no audio
        // re-running fills only clips that have no captions yet
        const already = project.texts.some((t) =>
          t.start < it.end - 0.05 && t.start + t.duration > it.start + 0.05);
        if (already) continue;
        st.textContent = "Listening to clip…";
        const a = await ensureAudio(clip.src);
        const sr = a.sampleRate;
        const s0 = Math.floor(clip.in * sr), s1 = Math.min(a.samples.length, Math.ceil(clip.out * sr));
        if (s1 - s0 < sr * 0.3) continue;
        const wav = window.FCAuto.encodeWav16k(a.samples.subarray(s0, s1), sr);
        const r = await window.FCAI.transcribeGroqPieces(settings.key, wav, 600,
          (i, n) => { st.textContent = "Transcribing part " + i + "/" + n + "…"; });
        failed += r.failed;
        for (const seg of window.FCAI.captionChunks(r.segments)) {
          const t = E.newText(it.start + seg.start / clip.speed);
          t.text = seg.text;
          t.duration = Math.max(0.4, (seg.end - seg.start) / clip.speed);
          t.position = "bottom-center"; t.box = true;
          project.texts.push(t);
          added++;
        }
      }
      pushUndo(); renderAll(); sheetMode = "ai"; renderSheet();
      $("ai_status").textContent = added
        ? "Done — added " + added + " captions." +
          (failed ? " (" + failed + " part(s) failed — re-run to fill the gaps)" : "")
        : failed ? "Captions failed — check your key and try again."
        : "No speech found in the audio.";
    } catch (e) {
      st.textContent = "Captions failed: " + e.message;
    }
  }

  // ------------------------------------------------------------ modal helper
  function openModal(html) {
    const card = $("modalCard");
    card.innerHTML = html;
    $("modal").classList.add("open");
  }
  function closeModal() { $("modal").classList.remove("open"); }
  $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

  // ------------------------------------------------------------ AI image
  const IMG_STYLES = [
    ["✨ Any (auto)", ""],
    ["📷 Realistic", ", realistic photo, detailed textures, natural lighting"],
    ["🎨 Cartoon", ", cartoon illustration, bold outlines, flat vibrant colors"],
    ["🌸 Anime", ", anime style, cel shading, vivid colors"],
    ["🧊 3D render", ", cute 3d render, soft studio lighting, pixar style"],
    ["🖌 Painting", ", digital painting, painterly brush strokes, artistic"],
  ];
  const IMG_SIZES = [["Wide 1280×720", [1280, 720]], ["Square 1080×1080", [1080, 1080]], ["Tall 1080×1920", [1080, 1920]]];
  let aiImgBytes = null;

  $("aiImgBtn").onclick = () => {
    openModal(`
      <h2>🖼 AI Image</h2>
      <textarea id="im_prompt" rows="3" placeholder="Describe the picture…">a cute cat astronaut, cinematic lighting</textarea>
      <div class="chips" id="im_styles">${IMG_STYLES.map(([l], i) =>
        `<button class="chip${i === 0 ? " on" : ""}" data-i="${i}">${l}</button>`).join("")}</div>
      <div class="chips" id="im_sizes">${IMG_SIZES.map(([l], i) =>
        `<button class="chip${i === 0 ? " on" : ""}" data-i="${i}">${l}</button>`).join("")}</div>
      <div class="note" id="im_note">Free, no payment — FreeCut writes a rich prompt from your idea and tries several free services until one answers.</div>
      <img id="im_view" class="hidden" style="width:100%;border-radius:10px;margin:4px 0 10px" alt="">
      <button class="btn" id="im_go">✨ Generate</button>
      <button class="btn hidden" id="im_add">＋ Add to timeline</button>`);
    let styleIdx = 0, sizeIdx = 0;
    const pick = (wrapId, set) => {
      document.querySelectorAll("#" + wrapId + " .chip").forEach((el) => (el.onclick = () => {
        set(+el.dataset.i);
        document.querySelectorAll("#" + wrapId + " .chip").forEach((x) => x.classList.toggle("on", x === el));
      }));
    };
    pick("im_styles", (i) => (styleIdx = i));
    pick("im_sizes", (i) => (sizeIdx = i));
    let viewUrl = null;

    $("im_go").onclick = async () => {
      const prompt = $("im_prompt").value.trim();
      if (!prompt) { $("im_note").textContent = "Describe the picture first."; return; }
      $("im_go").classList.add("hidden");
      $("im_add").classList.add("hidden");
      $("im_view").classList.add("hidden");
      try {
        const [w, h] = IMG_SIZES[sizeIdx][1];
        const r = await window.FCImage.generateImage(prompt, {
          style: IMG_STYLES[styleIdx][1], width: w, height: h,
          settings: window.FCAI.loadSettings(),
          onStatus: (m) => { $("im_note").textContent = m; },
        });
        aiImgBytes = r.bytes;
        if (viewUrl) URL.revokeObjectURL(viewUrl);
        viewUrl = URL.createObjectURL(new Blob([r.bytes]));
        const img = $("im_view");
        img.src = viewUrl;
        img.classList.remove("hidden");
        const settings = window.FCAI.loadSettings();
        const tip = r.provider.startsWith("pollinations") &&
          !(settings.provider === "gemini" && settings.key)
          ? " Tip: save a free Gemini key (🤖 AI → settings) for more accurate pictures." : "";
        $("im_note").textContent = "✓ Done (made with " + r.provider + ")." + tip;
        $("im_add").classList.remove("hidden");
      } catch (e) {
        $("im_note").textContent = "Could not generate: " + e.message;
      }
      $("im_go").classList.remove("hidden");
    };

    $("im_add").onclick = () => {
      if (!aiImgBytes) return;
      const name = "m" + (++srcCounter) + ".png";
      const blob = new Blob([aiImgBytes], { type: "image/png" });
      media.set(name, {
        file: blob, url: URL.createObjectURL(blob), duration: 3600,
        kind: "image", hasAudio: false, name: "AI image " + name,
      });
      const clip = E.newImageClip(name, 3);
      project.clips.push(clip);
      selectedClipId = clip.id;
      pushUndo(); renderAll(); closeModal();
    };
  };

  // ------------------------------------------------------------ export
  $("exportBtn").onclick = () => {
    if (!project.clips.length) return;
    openModal(`
      <h2>Export video</h2>
      <div class="chips">
        <button class="chip" data-p="draft">Draft 480p</button>
        <button class="chip on" data-p="hd">HD 720p</button>
        <button class="chip" data-p="fhd">Full HD 1080p</button>
      </div>
      <div class="chips">
        <button class="chip" data-p="tiktok">📱 TikTok / Reels</button>
        <button class="chip" data-p="square">⬛ Square post</button>
      </div>
      <div class="note" id="ex_hint">Exports on your device — no upload. The first export downloads the video engine (~25 MB, then it's cached).</div>
      <div id="progWrap" style="display:none">
        <div id="progBar"><div id="ex_fill"></div></div>
        <div id="progLbl">Starting…</div>
      </div>
      <button class="btn" id="ex_start">Export MP4</button>
      <button class="btn hidden" id="ex_save">💾 Save video</button>`);
    let preset = "hd";
    document.querySelectorAll("#modalCard .chip[data-p]").forEach((el) => (el.onclick = () => {
      preset = el.dataset.p;
      document.querySelectorAll("#modalCard .chip[data-p]").forEach((x) => x.classList.toggle("on", x === el));
    }));
    $("ex_start").onclick = () => runExport(preset);
  };

  let lastBlob = null, lastName = "freecut.mp4";
  async function runExport(preset) {
    $("ex_start").classList.add("hidden");
    $("ex_hint").style.display = "none";
    $("progWrap").style.display = "block";
    const say = (t) => ($("progLbl").textContent = t);
    const bar = (f) => ($("ex_fill").style.width = Math.round(f * 100) + "%");
    try {
      say("Loading video engine… (first time downloads ~25 MB)");
      bar(0.02);
      await runner.ensureLoaded();

      say("Preparing files…");
      const inputs = {};
      const names = new Set(project.clips.map((c) => c.src));
      if (project.music) names.add(project.music.src);
      for (const n of names) {
        inputs[n] = new Uint8Array(await media.get(n).file.arrayBuffer());
      }
      let fontName = null;
      try {
        const fr = await fetch("assets/font.ttf");
        if (fr.ok) {
          fontName = "font.ttf";
          inputs[fontName] = new Uint8Array(await fr.arrayBuffer());
        }
      } catch (e) { /* captions fall back to default font */ }
      for (const n of Object.keys(inputs)) {
        await runner.writeInput(n, inputs[n]);
      }

      say("Analyzing audio…");
      for (const n of names) {
        const m = media.get(n);
        if (m.kind !== "audio" && m.hasAudio === null) {
          const p = await runner.probe(new File([m.file], n, { type: m.file.type }), n);
          m.hasAudio = p.hasAudio;
        }
      }

      const mediaInfo = {};
      for (const [n, m] of media) mediaInfo[n] = { duration: m.duration, hasAudio: !!m.hasAudio };
      const graph = E.buildGraph(project, mediaInfo, { preset, fontFile: fontName });
      if (graph.textsSkipped) console.warn("font missing — text overlays skipped");
      const enc = new TextEncoder();
      for (const [fn, content] of Object.entries(graph.textFiles)) {
        await runner.writeInput(fn, enc.encode(content));
      }

      say("Exporting… 0%");
      const data = await runner.exportMp4(graph.args, graph.total, (frac) => {
        bar(0.05 + 0.9 * frac);
        say("Exporting… " + Math.round(frac * 100) + "%");
      });
      await runner.cleanup(Object.keys(inputs).concat(Object.keys(graph.textFiles), ["out.mp4"]));

      bar(1); say("Done! Tap Save.");
      lastBlob = new Blob([data], { type: "video/mp4" });
      lastName = "FreeCut-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".mp4";
      $("ex_save").classList.remove("hidden");
      $("ex_save").onclick = saveExport;
    } catch (err) {
      say("Export failed: " + (err && err.message ? err.message : err));
      $("ex_start").classList.remove("hidden");
    }
  }

  async function saveExport() {
    if (!lastBlob) return;
    if (window.AndroidBridge && window.AndroidBridge.startSave) {
      // chunked base64 transfer to native shell → MediaStore
      window.AndroidBridge.startSave(lastName);
      const buf = new Uint8Array(await lastBlob.arrayBuffer());
      const CHUNK = 512 * 1024;
      for (let i = 0; i < buf.length; i += CHUNK) {
        let s = "";
        const sub = buf.subarray(i, Math.min(i + CHUNK, buf.length));
        for (let j = 0; j < sub.length; j++) s += String.fromCharCode(sub[j]);
        window.AndroidBridge.saveChunk(btoa(s));
        await new Promise((r) => setTimeout(r, 0));
      }
      window.AndroidBridge.endSave();
      $("progLbl").textContent = "Saved to Gallery (Movies folder)";
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(lastBlob);
      a.download = lastName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      $("progLbl").textContent = "Download started";
    }
  }

  // ------------------------------------------------------------ render + boot
  function renderAll() {
    renderTimeline();
    renderSheet();
    renderFrame();
  }

  // PWA
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // debug / automation hook
  window.FC = { project, media, renderAll, getLastBlob: () => lastBlob };
  renderAll();
})();
