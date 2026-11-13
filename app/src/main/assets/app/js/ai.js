/* FreeCut Mobile — online AI (optional, free keys, actions-only).
 * The AI receives only a text instruction + numeric summary of the project.
 * It returns a list of edit actions which run locally on the phone.
 * Captions upload audio only (16 kHz WAV) to the chosen provider.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(root);
  else root.FCAI = factory(root);
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  const LS_KEY = "fc_ai_settings";
  const GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];
  const GROQ_CHAT = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

  function loadSettings() {
    try { return JSON.parse(root.localStorage.getItem(LS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveSettings(s) {
    root.localStorage.setItem(LS_KEY, JSON.stringify({
      provider: s.provider || "gemini", key: s.key || "", model: s.model || "",
    }));
  }

  // ------------------------------------------------------------ prompt
  const ACTIONS_DOC = `You are the brain of a mobile video editor. The user tells you what to do;
you reply ONLY with a JSON object: {"actions": [...]}. Allowed actions:
{"do":"remove_silences"}                     cut out silent parts of every clip
{"do":"split_scenes"}                        cut clips at visual scene changes
{"do":"speed_all","x":2.0}                   speed every clip (0.25..4)
{"do":"volume_all","x":1.5}                  set clip volume (0..2)
{"do":"mute_all"} / {"do":"unmute_all"}
{"do":"black_white_all","on":true}           black & white filter on/off
{"do":"add_text","text":"...","position":"bottom-center","start":0,"duration":3}
positions: top-left, top-center, top-right, middle-left, center, middle-right,
bottom-left, bottom-center, bottom-right.
Rules: combine actions when asked for several things; no explanation, JSON only;
if the request is impossible, return {"actions":[]}.`;

  function buildContext(project, layoutFn) {
    const L = layoutFn(project);
    return {
      clips: project.clips.map((c, i) => ({
        n: i + 1, duration: +(L.items[i] ? L.items[i].dur : 0).toFixed(1),
        speed: c.speed, muted: c.muted,
      })),
      totalSeconds: +L.total.toFixed(1),
      texts: project.texts.length,
      hasMusic: !!project.music,
    };
  }

  function extractJson(text) {
    if (!text) return null;
    let s = String(text).trim();
    const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) s = m[1].trim();
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  // ------------------------------------------------------------ validation
  const POSITIONS = ["top-left","top-center","top-right","middle-left","center",
    "middle-right","bottom-left","bottom-center","bottom-right"];

  function validateActions(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const a of list) {
      if (!a || typeof a.do !== "string") continue;
      switch (a.do) {
        case "remove_silences": case "split_scenes":
        case "mute_all": case "unmute_all":
          out.push({ do: a.do }); break;
        case "speed_all": {
          const x = Math.min(4, Math.max(0.25, +a.x || 1));
          out.push({ do: "speed_all", x }); break;
        }
        case "volume_all": {
          let x = +a.x; if (!isFinite(x)) x = 1;
          out.push({ do: "volume_all", x: Math.min(2, Math.max(0, x)) }); break;
        }
        case "black_white_all":
          out.push({ do: "black_white_all", on: !!a.on }); break;
        case "add_text": {
          const t = String(a.text || "").trim();
          if (!t) break;
          out.push({ do: "add_text", text: t.slice(0, 200),
            position: POSITIONS.includes(a.position) ? a.position : "bottom-center",
            start: Math.max(0, +a.start || 0),
            duration: Math.min(60, Math.max(0.5, +a.duration || 3)) });
          break;
        }
      }
      if (out.length >= 10) break;
    }
    return out;
  }

  // ------------------------------------------------------------ providers
  async function post(url, opts) {
    const res = await fetch(url, opts);
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch (e) {}
    if (!res.ok) {
      const msg = json && json.error && json.error.message ? json.error.message : body.slice(0, 200);
      const err = new Error(msg || ("HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async function geminiChat(key, prompt, exclude) {
    let lastErr = null;
    for (const model of GEMINI_MODELS) {
      if (exclude && exclude.has(model)) continue;
      try {
        const json = await post(
          "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
          { method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
        const text = json.candidates && json.candidates[0] &&
          json.candidates[0].content && json.candidates[0].content.parts &&
          json.candidates[0].content.parts.map((p) => p.text || "").join("");
        return { text, model };
      } catch (e) {
        lastErr = e;
        if (e.status === 404 || /not found|no longer|decommission/i.test(e.message)) continue;
        throw e; // auth/quota/network errors: stop immediately
      }
    }
    throw lastErr || new Error("No Gemini model available");
  }

  async function groqChat(key, prompt) {
    let lastErr = null;
    for (const model of GROQ_CHAT) {
      try {
        const json = await post("https://api.groq.com/openai/v1/chat/completions",
          { method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
            body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }],
              temperature: 0.2 }) });
        return { text: json.choices[0].message.content, model };
      } catch (e) {
        lastErr = e;
        if (e.status === 404 || /decommission|not found/i.test(e.message)) continue;
        throw e;
      }
    }
    throw lastErr || new Error("No Groq model available");
  }

  /** instruction + project → validated action list. Returns {actions, model}. */
  async function askActions(settings, project, layoutFn, instruction) {
    if (!settings.key) throw new Error("Add your free API key first (⚙ AI settings).");
    const ctx = buildContext(project, layoutFn);
    const prompt = ACTIONS_DOC + "\n\nProject (JSON): " + JSON.stringify(ctx) +
      "\n\nUser instruction: " + instruction + "\n\nJSON:";
    const r = settings.provider === "groq"
      ? await groqChat(settings.key, prompt)
      : await geminiChat(settings.key, prompt);
    const parsed = extractJson(r.text);
    return { actions: validateActions(parsed ? parsed.actions : []), model: r.model };
  }

  // ------------------------------------------------------------ captions
  /** Groq Whisper transcription of 16 kHz WAV bytes → [{start,end,text,words?}].
   *  Asks for word-level timestamps too — those give frame-accurate caption timing. */
  async function transcribeGroq(key, wavBytes) {
    const fd = new FormData();
    fd.append("file", new Blob([wavBytes], { type: "audio/wav" }), "audio.wav");
    fd.append("model", "whisper-large-v3-turbo");
    fd.append("response_format", "verbose_json");
    fd.append("timestamp_granularities[]", "word");
    fd.append("timestamp_granularities[]", "segment");
    const json = await post("https://api.groq.com/openai/v1/audio/transcriptions",
      { method: "POST", headers: { Authorization: "Bearer " + key }, body: fd });
    const words = (json.words || []).map((w) => ({
      start: +w.start || 0, end: +w.end || 0,
      text: String(w.word || "").trim(),
    })).filter((w) => w.text);
    const segs = (json.segments || []).map((s) => ({
      start: +s.start || 0, end: +s.end || 0,
      text: String(s.text || "").trim(),
      words: words.filter((w) => w.start >= (+s.start || 0) - 0.05 && w.end <= (+s.end || 0) + 0.25),
    })).filter((s) => s.text);
    if (!segs.length && words.length) {
      // no segments returned — synthesize one segment from the words
      segs.push({ start: words[0].start, end: words[words.length - 1].end,
        text: words.map((w) => w.text).join(" "), words });
    }
    if (!segs.length && json.text) segs.push({ start: 0, end: 3, text: String(json.text).trim() });
    return segs;
  }

  /** Split a 16 kHz mono 16-bit WAV (44-byte header) into time pieces. Pure + testable. */
  function splitWav16k(wavBytes, pieceSecs) {
    const piece = Math.max(1, pieceSecs || 600);
    const BYTES_PER_SEC = 32000;                    // 16000 samples × 2 bytes
    const dataStart = 44;                           // our encoder always writes a 44-byte header
    if (wavBytes.length <= dataStart) return [wavBytes];
    const pcm = wavBytes.subarray(dataStart);
    const chunkBytes = piece * BYTES_PER_SEC;
    if (pcm.length <= chunkBytes) return [wavBytes];
    const out = [];
    for (let off = 0; off < pcm.length; off += chunkBytes) {
      const part = pcm.subarray(off, Math.min(pcm.length, off + chunkBytes));
      const buf = new Uint8Array(dataStart + part.length);
      buf.set(wavBytes.subarray(0, dataStart), 0);  // copy header, then fix sizes
      const dv = new DataView(buf.buffer);
      dv.setUint32(4, 36 + part.length, true);
      dv.setUint32(40, part.length, true);
      buf.set(part, dataStart);
      out.push(buf);
    }
    return out;
  }

  /**
   * Transcribe a long WAV in pieces (Groq caps ~25 MB) with one retry per piece;
   * a piece that fails twice is skipped, the rest still lands.
   * Returns { segments, failed } — segment times are offset back to the full clip.
   */
  async function transcribeGroqPieces(key, wavBytes, pieceSecs, onStep) {
    const pieces = splitWav16k(wavBytes, pieceSecs || 600);
    const all = [];
    let failed = 0;
    for (let i = 0; i < pieces.length; i++) {
      if (onStep) onStep(i + 1, pieces.length);
      let segs = null, lastErr = null;
      for (let attempt = 0; attempt < 2 && !segs; attempt++) {
        try { segs = await transcribeGroq(key, pieces[i]); }
        catch (e) {
          lastErr = e;
          if (e.status === 401 || e.status === 403) throw e;   // bad key → stop everything
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (!segs) { failed++; continue; }
      const offset = i * (pieceSecs || 600);
      for (const s of segs) {
        s.start += offset; s.end += offset;
        if (s.words) s.words.forEach((w) => { w.start += offset; w.end += offset; });
        all.push(s);
      }
    }
    if (!all.length && failed === pieces.length && pieces.length > 0)
      throw new Error("Transcription failed for every part — check your key or try again later.");
    return { segments: all, failed };
  }

  /** Split long segments into caption-sized chunks (≤ ~8 words).
   *  Uses exact word timestamps when Whisper provided them. */
  function captionChunks(segments) {
    const out = [];
    for (const s of segments) {
      if (s.words && s.words.length > 8) {
        for (let i = 0; i < s.words.length; i += 8) {
          const grp = s.words.slice(i, i + 8);
          out.push({ start: grp[0].start, end: grp[grp.length - 1].end,
            text: grp.map((w) => w.text).join(" ") });
        }
        continue;
      }
      if (s.words && s.words.length) { out.push(s); continue; }
      const words = s.text.split(/\s+/).filter(Boolean);
      if (words.length <= 8) { out.push(s); continue; }
      const dur = Math.max(0.3, s.end - s.start);
      const per = dur / Math.ceil(words.length / 8);
      for (let i = 0; i < words.length; i += 8) {
        const k = i / 8;
        out.push({ start: s.start + k * per,
          end: Math.min(s.end, s.start + (k + 1) * per),
          text: words.slice(i, i + 8).join(" ") });
      }
    }
    return out;
  }

  /** Apply synchronous actions to the project; heavy ones come back deferred. */
  function applySyncActions(project, E, actions) {
    const deferred = [];
    let applied = 0;
    for (const a of actions) {
      switch (a.do) {
        case "remove_silences": case "split_scenes":
          deferred.push(a); break;
        case "speed_all":
          project.clips.forEach((c) => (c.speed = a.x)); applied++; break;
        case "volume_all":
          project.clips.forEach((c) => (c.volume = a.x)); applied++; break;
        case "mute_all":
          project.clips.forEach((c) => (c.muted = true)); applied++; break;
        case "unmute_all":
          project.clips.forEach((c) => (c.muted = false)); applied++; break;
        case "black_white_all":
          project.clips.forEach((c) => (c.filters.grayscale = a.on)); applied++; break;
        case "add_text": {
          const t = E.newText(a.start);
          t.text = a.text; t.position = a.position; t.duration = a.duration;
          project.texts.push(t); applied++; break;
        }
      }
    }
    return { deferred, applied };
  }

  /** Plain chat text reply — used by the AI-image prompt enricher. */
  async function chatText(settings, prompt) {
    if (!settings.key) throw new Error("no key");
    const r = settings.provider === "groq"
      ? await groqChat(settings.key, prompt)
      : await geminiChat(settings.key, prompt);
    return r.text || "";
  }

  return { loadSettings, saveSettings, askActions, transcribeGroq, transcribeGroqPieces,
           splitWav16k, captionChunks, validateActions, applySyncActions, buildContext,
           extractJson, chatText, geminiChat, groqChat };
});
