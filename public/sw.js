// Offline-capable shell. API calls are never cached (always fresh, always authenticated).
// Bump VERSION when the list of shell files changes.
const VERSION = 'hisaab-v8';
const SHELL = [
  '/', '/css/app.css', '/icons.svg', '/manifest.webmanifest', '/favicon.svg',
  '/vendor/oat.min.css', '/vendor/oat.min.js', '/vendor/charts.min.css', '/vendor/fonts/manrope-latin.woff2',
  '/js/app.js', '/js/api.js', '/js/ui.js', '/js/money.js', '/js/icon-list.js', '/js/icon-picker.js',
  '/js/home.js', '/js/analytics.js', '/js/categories.js', '/js/expense-dialog.js', '/js/login.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // Pages: network first, so an expired Access session redirects to login; cache only when offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }

  // Static files: network first so a deploy never mixes old and new modules; cache is the offline fallback.
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request)));
});
