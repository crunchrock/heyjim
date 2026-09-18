// Offline support. VERSION is rewritten by build/build.mjs on every build.
const VERSION = 'c396659af0';
const SHELL = ['./', 'index.html', 'styles.css', 'core.js', 'app.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open('shell-' + VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('shell-') && k !== 'shell-' + VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
async function cacheFirst(req, name) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') (await caches.open(name)).put(req, res.clone());
  return res;
}
async function networkFirst(req, name) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(name)).put(req, res.clone());
    return res;
  } catch {
    return (await caches.match(req, { ignoreSearch: true })) || Response.error();
  }
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    if (u.pathname.endsWith('/data.enc')) return e.respondWith(networkFirst(req, 'data'));
    if (req.mode === 'navigate') return e.respondWith(caches.match('index.html').then(r => r || fetch(req)));
    return e.respondWith(cacheFirst(req, 'shell-' + VERSION));
  }
  if (u.hostname === 'cdnjs.cloudflare.com') return e.respondWith(cacheFirst(req, 'lib'));
  if (u.hostname === 'tile.openstreetmap.org') return e.respondWith(cacheFirst(req, 'tiles'));
});
