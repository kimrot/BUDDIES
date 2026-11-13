// Minimal service worker: cache the app shell so it opens fast / installs as a PWA.
// API calls always go to the network.
const CACHE = 'buddies-v9';
const SHELL = ['/', '/index.html', '/style.css', '/account.js', '/plus.js', '/app.js', '/manifest.json', '/icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api')) return;
  // Network first, fall back to cache when offline.
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))));
});

// ---------- push notifications ----------
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Drinking Buddies', body: e.data?.text() }; }
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const focused = wins.find((w) => w.focused && w.visibilityState === 'visible');
    if (focused) {
      // App is open and in front: let it show the in-app match popup instead.
      focused.postMessage('check-notifications');
      return;
    }
    await self.registration.showNotification(data.title || 'Drinking Buddies', {
      body: data.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.tag,
      data: { url: data.url || '/' },
      vibrate: [80, 40, 80],
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) { await win.focus(); return win.navigate(url); }
    return clients.openWindow(url);
  })());
});
