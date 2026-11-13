/* FreeCut Mobile service worker: app-shell cache + ffmpeg engine cache. */
const SHELL = "freecut-shell-v1";
const ENGINE = "freecut-engine-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/editor.js",
  "./js/ffwrapper.js",
  "./js/app.js",
  "./assets/font.ttf",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && k !== ENGINE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = e.request.url;
  if (e.request.method !== "GET") return;
  // ffmpeg engine from CDN: cache-first so exports work offline after 1st use
  if (url.includes("@ffmpeg/")) {
    e.respondWith(
      caches.open(ENGINE).then((c) =>
        c.match(e.request).then((hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) c.put(e.request, res.clone());
            return res;
          })
        )
      )
    );
    return;
  }
  // app shell: cache-first, network fallback
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ||
      fetch(e.request).then((res) => {
        if (res.ok && new URL(url).origin === location.origin) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit)
    )
  );
});
