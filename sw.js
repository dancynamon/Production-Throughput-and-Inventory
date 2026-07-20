/* Aegis Inventory — service worker.
 * Caches the app shell so it opens instantly and works even on a flaky
 * shop-floor connection. API calls (JSONP <script> loads) are never cached —
 * they always go to the network so stock numbers stay live. */
var CACHE = 'aquamentor-prod-v7';
var SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  // Never intercept the Apps Script API — let it hit the network directly.
  if (url.hostname.indexOf('script.google') !== -1) return;
  if (e.request.method !== 'GET') return;

  // Cache-first for the app shell, falling back to network.
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      return cached || fetch(e.request).then(function (resp) {
        if (resp && resp.status === 200 && url.origin === self.location.origin) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return resp;
      }).catch(function () { return cached; });
    })
  );
});
