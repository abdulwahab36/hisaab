// Offline cache for the app shell. Bump VERSION after changing any file.
const VERSION = 'hisaab-v42';
const FILES = ['./', './index.html', './style.css?v=42', './config.js?v=42', './app.js?v=42', './manifest.json', './icon.svg?v=42', './icon-192.png?v=42', './icon-512.png?v=42', './fonts/inter-latin-400-normal.woff2', './fonts/inter-latin-600-normal.woff2', './fonts/inter-latin-700-normal.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first (so updates arrive), fall back to cache when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      // don't keep shared bank messages (they arrive in the address) in the cache
      if (!(e.request.mode === 'navigate' && new URL(e.request.url).search)) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
