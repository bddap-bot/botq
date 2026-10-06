// botq dashboard service worker. It exists to make the page installable:
// Firefox-Android's "Add to Home Screen" / app-list install requires a registered
// SW with a fetch handler. It caches nothing; the dashboard needs the network anyway.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('fetch', () => {});
