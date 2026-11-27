// Light Mapper offline cache. Bump CACHE (and VERSION in nav.js / APP_VERSION in recorder-ui.js) every deploy.
const CACHE = 'light-mapper-v3', RUNTIME = 'light-mapper-runtime';
const SHELL = ['./', 'index.html', 'nav.js', 'recorder-ui.js', 'ptp.js', 'recorder.js', 'charts.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const r = e.request; if (r.method !== 'GET') return;
  const url = new URL(r.url);
  if (url.origin === location.origin && url.pathname.endsWith('/routes/index.json')) {          // route list: network first
    e.respondWith(fetch(r).then((res) => { const c = res.clone(); caches.open(RUNTIME).then((k) => k.put(r, c)); return res; }).catch(() => caches.match(r))); return;
  }
  // everything else (app shell, route bundles, MapLibre, map style and tiles): cache, refreshed in the background
  e.respondWith(caches.match(r).then((hit) => {
    const net = fetch(r).then((res) => { if (res.ok || res.type === 'opaque') { const c = res.clone(); caches.open(url.origin === location.origin ? CACHE : RUNTIME).then((k) => k.put(r, c)); } return res; }).catch(() => hit);
    return hit || net;
  }));
});
