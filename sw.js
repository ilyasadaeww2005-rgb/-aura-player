const CACHE = 'aura-shell-v3';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-180.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  const shouldRefresh = event.request.mode === 'navigate' || ['script', 'style', 'manifest'].includes(event.request.destination);
  const network = () => fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  });
  event.respondWith(shouldRefresh
    ? network().catch(() => caches.match(event.request).then(hit => hit || caches.match('./index.html')))
    : caches.match(event.request).then(hit => hit || network()));
});
