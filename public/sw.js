const CACHE = 'chatroom-v2';
const STATIC = ['/css/style.css', '/js/app.js', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // Never touch API, socket.io, or upload requests
  if (url.pathname.startsWith('/auth') ||
      url.pathname.startsWith('/socket.io') ||
      url.pathname.startsWith('/uploads') ||
      url.pathname.startsWith('/rooms') ||
      url.pathname.startsWith('/room-info') ||
      url.pathname.startsWith('/search') ||
      url.pathname.startsWith('/join') ||
      url.pathname.startsWith('/messages') ||
      url.pathname.startsWith('/upload') ||
      url.pathname.startsWith('/dm') ||
      url.pathname.startsWith('/users') ||
      url.pathname.startsWith('/reactions') ||
      url.pathname.startsWith('/profile')) {
    return;
  }
  // Network-first for app assets so deploys reach users immediately;
  // fall back to the cached copy when offline.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
