// botq dashboard service worker. Its main job is to make the page INSTALLABLE:
// Firefox-Android's "Add to Home Screen" / app-list install requires a registered
// SW with a fetch handler. It also caches the static bootstrap shell so the
// launcher icon opens instantly (and offline). The live dashboard UI itself
// arrives over the iroh tunnel at runtime (GET_UI) — it never travels over HTTP,
// so it never reaches this handler and is never cached here.
const CACHE = 'botq-shell-v1';
const SHELL = [
  '.', 'index.html', 'manifest.webmanifest',
  'botq_dash_wasm.js', 'botq_dash_wasm_bg.wasm',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first for our own shell (so a fresh GH-Pages deploy is picked up
// promptly), falling back to cache when offline — that fallback is what lets the
// installed app launch with no network.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;  // only our shell
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      // Offline: the exact request if cached, else the app-shell root ('.' ⇒
      // /botq/, how a navigation to the scope root is cached).
      .catch(() => caches.match(req).then((m) => m || caches.match('.'))),
  );
});
