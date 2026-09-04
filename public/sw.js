// Bump this whenever the caching strategy changes — activate() deletes every
// cache that isn't the current name, so an old worker's store can't linger.
const CACHE = 'chatroom-v4';
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

// ── Push ─────────────────────────────────────────────────────────────────────
//
// The only way an iPhone can be notified by this app. iOS installs nothing
// Apple has not signed, so there is no native app to receive an APNs push —
// but since iOS 16.4 a PWA added to the HOME SCREEN can receive a Web Push,
// and that is what this handler is. Android and desktop browsers get the same
// thing; the Android app has Firebase instead.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  const title = d.title || 'New message';
  const body = d.body || '';
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // One notification per chat, replaced rather than stacked: twenty buzzes
    // from the same conversation is how people turn notifications off.
    tag: d.roomId ? `room-${d.roomId}` : 'chat',
    renotify: true,
    data: { roomId: d.roomId || '', msgId: d.msgId || '', parentId: d.parentId || '' },
  }));
});

// Tapping it opens the chat it was about — in the window that is already open
// where there is one, rather than a second copy of the app.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const roomId = data.roomId || '';
  // A comment's notification names the message it hangs off, so the page can
  // open the THREAD rather than a conversation the comment is not in.
  const parentId = data.parentId || '';
  const url = roomId ? `/?join=${encodeURIComponent(roomId)}` : '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      await c.focus();
      // The page knows how to open a room without a reload.
      c.postMessage({ type: 'open-room', roomId, parentId, msgId: data.msgId || '' });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
