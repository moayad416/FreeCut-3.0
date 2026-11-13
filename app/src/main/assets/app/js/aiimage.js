/* FreeCut Mobile — free AI image generation (port of desktop FreeCut's chain).
 * Order: 0) enrich the idea into a rich prompt (chat AI, when a key is saved)
 *        1) Gemini image models, when a Gemini key is saved (best quality)
 *        2) pollinations.ai "flux", no key, retried when the free pool is busy
 * Pure helpers (detectStyle, buildImagePrompt, pickImageModel) are Node-testable.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(root);
  else root.FCImage = factory(root);
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  const IMAGE_QUALITY_SUFFIX =
    ", expressive characters with clear faces, detailed background, soft cinematic lighting, " +
    "vivid colors, sharp focus, high detail, good composition";

  const STYLE_TABLE = [
    [/\b(cartoon|comic|toon)\w*/, "cartoon illustration, bold outlines, flat vibrant colors, exaggerated funny expressions"],
    [/\b(anime|manga)\w*/,        "anime style, cel shading, vivid colors"],
    [/\bpixel\w*/,                "pixel art, 16-bit game style"],
    [/\b(3d|pixar|render)\w*/,    "cute 3d render, soft studio lighting, pixar style"],
    [/\b(realistic|photo)\w*/,    "realistic photo, detailed textures, natural lighting"],
    [/\b(painting|oil|watercolor|artistic)\w*/, "digital painting, painterly brush strokes, artistic"],
  ];

  /** Detect a drawing style from the user's own words (used when the picker says "Any"). */
  function detectStyle(prompt) {
    const p = " " + String(prompt || "").toLowerCase() + " ";
    for (const [re, phrase] of STYLE_TABLE) if (re.test(p)) return phrase;
    return "";
  }

  /** Style FIRST (image models weight the start most), auto-detected when picker = Any. */
  function buildImagePrompt(prompt, style) {
    const idea = String(prompt || "").trim();
    let st = String(style || "").trim().replace(/^[\s,]+/, "").trim();
    if (!st) st = detectStyle(idea);
    return (st ? st + " — " + idea : idea) + IMAGE_QUALITY_SUFFIX;
  }

  /** Pick the best image model from a live /models list (flash-image first, stable over preview). */
  function pickImageModel(names) {
    const cand = (names || [])
      .map((n) => (n.startsWith("models/") ? n.slice(7) : n))
      .filter((n) => /image/i.test(n));
    if (!cand.length) return null;
    const flash = cand.filter((n) => /flash/i.test(n));
    const pool = flash.length ? flash : cand;
    const vkey = (n) => {
      const m = n.match(/gemini-(\d+(?:\.\d+)*)/);
      return m ? m[1].split(".").map(Number) : [0];
    };
    return pool.sort((a, b) => {
      const pa = /preview|exp/i.test(a) ? 1 : 0, pb = /preview|exp/i.test(b) ? 1 : 0;
      if (pa !== pb) return pa - pb;
      const va = vkey(a), vb = vkey(b);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (vb[i] || 0) - (va[i] || 0);
        if (d) return d;
      }
      return a < b ? -1 : a > b ? 1 : 0;
    })[0];
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function looksLikeImage(bytes) {
    return bytes && bytes.length > 4 &&
      ((bytes[0] === 0xff && bytes[1] === 0xd8) ||                                  // jpeg
       (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) || // png
       (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46));  // riff/webp
  }

  async function geminiImageOnce(key, model, prompt) {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
      { method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Generate an image: " + prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }) });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403)
        throw new Error("the saved Gemini key was rejected");
      return null; // 400/404/429/… → try the next candidate
    }
    const json = await res.json();
    for (const cand of json.candidates || []) {
      for (const part of (cand.content && cand.content.parts) || []) {
        const idata = part.inlineData || part.inline_data;
        if (!idata || !idata.data) continue;
        const mime = idata.mimeType || idata.mime_type || "";
        if (mime && !mime.startsWith("image/")) continue;
        try {
          const bytes = b64ToBytes(idata.data);
          if (looksLikeImage(bytes)) return bytes;
        } catch (e) { /* not base64 → keep looking */ }
      }
    }
    return null;
  }

  async function geminiImageModels(key) {
    const out = [];
    const seen = new Set();
    const add = (m) => { if (m && !seen.has(m)) { seen.add(m); out.push(m); } };
    try {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models",
        { headers: { "x-goog-api-key": key } });
      if (res.ok) {
        const json = await res.json();
        add(pickImageModel((json.models || []).map((m) => m.name || "")));
      }
    } catch (e) { /* listing failed → rely on fallbacks */ }
    add("gemini-2.5-flash-image");
    add("gemini-2.0-flash-preview-image-generation");
    add("gemini-2.0-flash-exp-image-generation");
    return out;
  }

  async function pollinationsImage(prompt, width, height) {
    const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) +
      "?width=" + width + "&height=" + height +
      "&nologo=true&referrer=freecut-app&model=flux&seed=" + Math.floor(Math.random() * 999998 + 1);
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    const mime = res.headers.get("content-type") || "";
    if (buf.length < 5000 || !(mime.startsWith("image/") || looksLikeImage(buf))) return null;
    return buf;
  }

  /**
   * Generate an image. opts: {style, width, height, settings:{provider,key}, onStatus(msg)}.
   * Returns { bytes, provider }.
   */
  async function generateImage(prompt, opts) {
    opts = opts || {};
    const width = opts.width || 1280, height = opts.height || 720;
    const settings = opts.settings || {};
    const say = opts.onStatus || (() => {});
    const notes = [];

    // step 0 — enrich the idea into a rich prompt (best-effort)
    let finalPrompt;
    if (settings.key && root.FCAI && root.FCAI.chatText) {
      say("Thinking up a detailed prompt…");
      try {
        const ask = "Rewrite this picture idea as ONE detailed image-generation prompt, at most 60 words. " +
          "Start with the art style, then describe EVERY element the user mentioned — each character, " +
          "action and object, nothing may be dropped — then the composition, lighting and colors. " +
          "Reply with ONLY the prompt text — no quotes, no explanation.\n\nPicture idea: " + prompt +
          (opts.style ? "\nWanted style: " + opts.style : "");
        const rich = (await root.FCAI.chatText(settings, ask)).trim().replace(/^"+|"+$/g, "").trim();
        finalPrompt = rich.length >= 10 && rich.length <= 900 && !rich.includes("\n")
          ? rich : buildImagePrompt(prompt, opts.style);
      } catch (e) { finalPrompt = buildImagePrompt(prompt, opts.style); }
    } else {
      finalPrompt = buildImagePrompt(prompt, opts.style);
    }

    // provider 1 — Gemini image models (own key, best quality)
    if (settings.provider === "gemini" && settings.key) {
      for (const model of await geminiImageModels(settings.key)) {
        say("Drawing with Gemini " + model + "…");
        try {
          const bytes = await geminiImageOnce(settings.key, model, finalPrompt);
          if (bytes) return { bytes, provider: "Gemini " + model };
          notes.push("Gemini " + model + ": no picture in the reply");
        } catch (e) {
          if (/rejected/.test(e.message)) throw e;
          notes.push("Gemini " + model + ": " + e.message);
        }
      }
    }

    // provider 2 — pollinations.ai flux, retried when the free pool is busy
    for (let attempt = 0; attempt < 3; attempt++) {
      say(attempt ? "Free service is busy — retrying…" : "Drawing…");
      try {
        const bytes = await pollinationsImage(finalPrompt, width, height);
        if (bytes) return { bytes, provider: "pollinations.ai (flux)" };
        notes.push("the free image service sent back no picture");
      } catch (e) {
        notes.push("free image service busy (" + e.message + ")");
      }
      if (attempt < 2) await sleep(8000);
    }

    throw new Error("All free image services are busy right now — please try again in a minute." +
      (notes.length ? " (" + notes.slice(0, 2).join("; ") + ")" : ""));
  }

  return { IMAGE_QUALITY_SUFFIX, STYLE_TABLE, detectStyle, buildImagePrompt,
           pickImageModel, looksLikeImage, generateImage };
});
