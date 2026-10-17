/**
 * App shell cache-first. Los datos (/api/...) NO pasan por aquí: los maneja
 * api.js con IndexedDB, que sabe distinguir "sin red" de "error del servidor".
 *
 * IMPORTANTE: cada vez que cambies HTML/CSS/JS, sube VERSION. Con cache-first
 * el celular seguirá mostrando la versión vieja hasta que cambie este número.
 */
const VERSION = "rm-shell-v3";
const SHELL = [
  "/",
  "/index.html",
  "/css/style.css",
  "/js/shell.js",
  "/js/api.js",
  "/js/sync.js",
  "/js/db.js",
  "/js/dashboard.js",
  "/js/views.js",
  "/js/ui.js",
  "/js/scanner.js",
  "/manifest.json",
  // Agrega aquí los íconos cuando existan (si un archivo de la lista no
  // existe, la instalación completa falla).
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => (request.mode === "navigate" ? caches.match("/index.html") : Response.error()))),
  );
});
