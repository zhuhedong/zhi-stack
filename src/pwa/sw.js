/* InfoHub service worker. Generated into dist/sw.js by the Vite pwa plugin,
 * which replaces the VERSION and PRECACHE placeholders. It caches only the
 * public app shell; API traffic is never intercepted or cached here. Saved
 * articles for offline reading live in the "infohub-articles" cache, written
 * by the page itself when offline reading is enabled on this device. */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = 'infohub-shell-' + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(['/index.html', ...PRECACHE]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('infohub-shell-') && k !== SHELL).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
  if (request.mode === 'navigate') {
    // Network first so deployments and server-side pages win; the cached shell
    // only answers when the network is unavailable.
    event.respondWith(
      fetch(request).catch(() =>
        caches.open(SHELL).then((cache) => cache.match('/index.html', { ignoreVary: true })),
      ),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        // The server varies on Origin (CORS); module scripts send it, precache requests did not.
        const hit = await cache.match(request, { ignoreVary: true, ignoreSearch: false });
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') void cache.put(request, response.clone());
        return response;
      }),
    );
  }
});
