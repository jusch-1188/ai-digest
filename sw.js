// AI Digest — Service Worker v3
//
// Cache strategy per resource type:
//   /data/index.json          → network-first  (always try fresh; fallback to cache)
//   /data/PAST_DATE.json      → cache-first    (historical data is immutable)
//   /data/TODAY.json          → network-first  (may be updated during the day)
//   /index.html, /manifest.json → network-first (shell; fallback to cache)
//   CDN (jsdelivr)            → cache-first    (icons/fonts don't change)
//
// No pre-caching on activate — the manifest + page fetches handle warming the cache.
// Cache version is bumped here when sw.js itself changes; activate clears old caches.

const SHELL_CACHE = 'ai-digest-shell-v3';
const DATA_CACHE  = 'ai-digest-data-v3';
const SHELL_URLS  = ['/', '/index.html', '/manifest.json'];

// ── Helpers ─────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Put a response in cache, cloning it first so the original stream stays usable.
function putInCache(cacheName, request, response) {
  if (!response || !response.ok) return;
  const clone = response.clone();
  caches.open(cacheName).then(cache => cache.put(request, clone));
}

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  // Cache the shell immediately so the app works offline from first load.
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  const validCaches = [SHELL_CACHE, DATA_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => !validCaches.includes(k))
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
  // No pre-caching here — the app fetches exactly what it needs via the manifest.
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ── 1. index.json: network-first, fallback to cache ─────────
  if (url.pathname === '/data/index.json') {
    event.respondWith(
      fetch(event.request)
        .then(res => { putInCache(DATA_CACHE, event.request, res); return res; })
        .catch(() => caches.match(event.request)
          .then(c => c || new Response('{"dates":[]}', {
            headers: { 'Content-Type': 'application/json' }
          }))
        )
    );
    return;
  }

  // ── 2. Daily data files ──────────────────────────────────────
  if (url.pathname.startsWith('/data/') && url.pathname.endsWith('.json')) {
    const dateMatch = url.pathname.match(/\/data\/(\d{4}-\d{2}-\d{2})\.json$/);
    const fileDate  = dateMatch ? dateMatch[1] : null;
    const isPast    = fileDate && fileDate < todayStr();

    if (isPast) {
      // Historical file: cache-first (immutable — never changes after the day is done)
      event.respondWith(
        caches.open(DATA_CACHE).then(async cache => {
          const cached = await cache.match(event.request);
          if (cached) return cached;
          const res = await fetch(event.request);
          putInCache(DATA_CACHE, event.request, res);
          return res;
        })
      );
    } else {
      // Today's file: network-first (pipeline may have just updated it)
      event.respondWith(
        fetch(event.request)
          .then(res => { putInCache(DATA_CACHE, event.request, res); return res; })
          .catch(() => caches.open(DATA_CACHE)
            .then(cache => cache.match(event.request))
            .then(c => c || new Response('[]', {
              headers: { 'Content-Type': 'application/json' }
            }))
          )
      );
    }
    return;
  }

  // ── 3. Shell files: network-first, fallback to cache ────────
  if (SHELL_URLS.includes(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then(res => { putInCache(SHELL_CACHE, event.request, res); return res; })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // ── 4. CDN resources (icons/fonts): cache-first ─────────────
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request)
          .then(res => { putInCache(SHELL_CACHE, event.request, res); return res; })
          .catch(() => new Response('', { status: 503 }));
      })
    );
  }
});
