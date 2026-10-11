/* Service worker for the bookcase: makes it installable, quick to open, and
   browsable offline for the shelves already seen.

   The page, three.js and fonts   cached copy first, refreshed in the background
   /ajax/search (book order)      network first, cached copy when offline
   /ajax/books, /ajax/book, info  cached copy first, refreshed in the background
   /get/thumb (covers)            cached for 30 days, at most THUMB_LIMIT of them
   Downloads and anything else go straight to the network. */
'use strict';

const VERSION = 'v1';
const SHELL = `bookcase-shell-${VERSION}`;
const DATA = `bookcase-data-${VERSION}`;
const COVERS = `bookcase-covers-${VERSION}`;
const KEEP = new Set([SHELL, DATA, COVERS]);
const THUMB_LIMIT = 4000;
const THUMB_DAYS = 30;
const DATA_LIMIT = 600;
const SHELL_FILES = ['./', 'bookcase.js', 'three.min.js', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // One missing optional file (fonts, three.js) must not stop the install.
    await Promise.all(SHELL_FILES.map((f) => cache.add(f).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('bookcase-') && !KEEP.has(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// Pull-to-refresh: refetch every cached app file, forget cached titles and
// details (covers stay), then tell the page it can reload.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'refresh') return;
  event.waitUntil((async () => {
    await caches.delete(DATA);
    const cache = await caches.open(SHELL);
    const keys = await cache.keys();
    await Promise.all(keys.map(async (req) => {
      try {
        const res = await fetch(req, { cache: 'reload' });
        if (res.ok) await cache.put(req, res);
      } catch (e) { /* keep the cached copy */ }
    }));
    if (event.ports[0]) event.ports[0].postMessage('done');
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  const p = url.pathname;

  if (p.startsWith(scope)) event.respondWith(staleWhileRevalidate(req, SHELL, event));
  else if (/^\/get\/thumb\//.test(p)) event.respondWith(coverFirst(req, event));
  else if (/^\/ajax\/search(\/|$)/.test(p)) event.respondWith(networkFirst(req, DATA));
  else if (/^\/ajax\/(books|book|library-info)(\/|$)/.test(p)) event.respondWith(staleWhileRevalidate(req, DATA, event, DATA_LIMIT));
});

async function put(cacheName, req, res, limit) {
  if (!res || !res.ok || res.type !== 'basic') return;
  const cache = await caches.open(cacheName);
  await cache.put(req, res);
  if (limit) await trim(cache, limit);
}

async function trim(cache, limit) {
  const keys = await cache.keys();          // oldest first
  for (let i = 0; i < keys.length - limit; i++) await cache.delete(keys[i]);
}

async function staleWhileRevalidate(req, cacheName, event, limit) {
  const cached = await caches.match(req, { cacheName });
  const fresh = fetch(req).then((res) => {
    event.waitUntil(put(cacheName, req, res.clone(), limit));
    return res;
  });
  if (cached) {
    event.waitUntil(fresh.catch(() => {}));
    return cached;
  }
  return fresh;
}

async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req);
    await put(cacheName, req, res.clone(), DATA_LIMIT);
    return res;
  } catch (e) {
    const cached = await caches.match(req, { cacheName });
    if (cached) return cached;
    throw e;
  }
}

async function coverFirst(req, event) {
  const cache = await caches.open(COVERS);
  const cached = await cache.match(req);
  if (cached) {
    const fetched = Date.parse(cached.headers.get('date') || '');
    if (isNaN(fetched) || Date.now() - fetched < THUMB_DAYS * 864e5) return cached;
  }
  try {
    const res = await fetch(req);
    if (res.ok) {
      // Re-adding moves it to the end, so trimming drops the least recently fetched.
      await cache.delete(req);
      event.waitUntil(put(COVERS, req, res.clone(), THUMB_LIMIT));
    }
    return res;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}
