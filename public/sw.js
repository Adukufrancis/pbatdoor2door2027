// PBAT DOOR TO DOOR: service worker. Keeps the site usable on poor or no network.
//
// - Pages, CSS and JS: try the network first (so updates show straight away), but if it takes more than
//   a few seconds or fails, use the copy saved on the phone. Pages never seen before fall back to /offline.
// - Photos and fonts: shown from the phone straight away and refreshed in the background.
// - Polling-unit lists (/geo): saved the first time they're opened, then always read from the phone.
// - Sign-in and account data (/api): never saved; always live.
//
// Bump VERSION when you change the list below; old saved copies are then cleared.
const VERSION = 'v2';
const SHELL = `pbat-shell-${VERSION}`;
const RUNTIME = `pbat-runtime-${VERSION}`;
const GEO = 'pbat-geo-v1';
const NETWORK_TIMEOUT_MS = 4000;

const PRECACHE = [
  '/', '/offline', '/login', '/join', '/privacy', '/terms', '/contact', '/volunteer', '/account',
  '/styles.css', '/app.js', '/motion.js', '/social.js', '/site-info.js', '/volunteer-page.js', '/toolkit.js', '/phone.js',
  '/site.webmanifest', '/favicon.ico',
  '/images/logo-transparent.png', '/images/logo.png', '/images/icon-192.png', '/images/icon-512.png',
  '/images/favicon-32.png', '/images/hero.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Add one by one so a single missing file doesn't stop the rest being saved.
    await Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, RUNTIME, GEO]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: keep a copy so text looks right offline.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, RUNTIME));
    return;
  }
  if (url.origin !== self.location.origin) return;               // everything else from other sites: leave alone
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;   // live data only

  if (url.pathname.startsWith('/geo/')) { event.respondWith(cacheFirst(req, GEO)); return; }
  if (url.pathname.startsWith('/images/')) { event.respondWith(staleWhileRevalidate(req, RUNTIME)); return; }

  if (req.mode === 'navigate') { event.respondWith(page(event)); return; }
  event.respondWith(networkFirst(event, req));                     // CSS, JS, manifest
});

/** Pages: network first; saved copy if slow or offline; the offline page if we've never seen it. */
async function page(event) {
  const res = await networkFirst(event, event.request);
  if (res && res.type !== 'error') return res;                     // any real answer from the server (even "not found")
  return (await caches.match('/offline')) || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

async function networkFirst(event, req) {
  const cache = await caches.open(req.mode === 'navigate' ? SHELL : RUNTIME);
  const fromNet = fetch(req).then((res) => {
    if (res.ok && !res.redirected) cache.put(req, res.clone());
    return res;
  });
  event.waitUntil(fromNet.catch(() => {}));                        // keep updating the saved copy even after a timeout
  const saved = () => cache.match(req, { ignoreSearch: req.mode === 'navigate' }).then((r) => r || caches.match(req, { ignoreSearch: true }));
  try {
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, 'timeout'));
    const res = await Promise.race([fromNet, timeout]);
    if (res !== 'timeout') return res;
    return (await saved()) || await fromNet;                       // slow network: use the saved copy if there is one
  } catch {
    return (await saved()) || Response.error();
  }
}

async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name);
  const saved = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => null);
  return saved || (await fresh) || Response.error();
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const saved = await cache.match(req);
  if (saved) return saved;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
