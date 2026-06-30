const CACHE = 'chatroom-v1';
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
  // Never cache API, socket.io, or upload requests
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/auth') ||
      url.pathname.startsWith('/socket.io') ||
      url.pathname.startsWith('/uploads') ||
      url.pathname.startsWith('/rooms') ||
      url.pathname.startsWith('/messages') ||
      url.pathname.startsWith('/upload') ||
      url.pathname.startsWith('/dm') ||
      url.pathname.startsWith('/users') ||
      url.pathname.startsWith('/reactions') ||
      url.pathname.startsWith('/profile')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
