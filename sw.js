// AI Digest — Service Worker v4
//
// Hashed app assets (app.*.css, app.*.js) are NOT cached here.
// Vercel serves them with Cache-Control: immutable, max-age=31536000,
// so the browser's HTTP cache handles them for a full year.
// The SW only manages resources whose content can change without a filename change.
//
// Cache strategy per resource:
//   /data/index.json          → network-first, fallback to cache
//   /data/PAST_DATE.json      → cache-first, immutable (historical data never changes)
//   /data/TODAY.json          → network-first (pipeline may update during the day)
//   /index.html, /manifest    → network-first, fallback to cache
//   CDN (jsdelivr)            → cache-first (icon fonts rarely change)

const SHELL_CACHE = 'ai-digest-shell-v4';
const DATA_CACHE  = 'ai-digest-data-v4';

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Helper: clone synchronously then put in cache ────────────
function putInCache(cacheName, request, response) {
  if (!response || !response.ok) return;
  const clone = response.clone(); // must clone before body is consumed
  caches.open(cacheName).then(cache => cache.put(request, clone));
}

// ── Install ──────────────────────────────────────────────────
// Cache only the shell. Hashed assets are handled by HTTP cache.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(['/', '/index.html', '/manifest.json']))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ─────────────────────────────────────────────────
// Delete caches from previous SW versions.
self.addEventListener('activate', event => {
  const keep = [SHELL_CACHE, DATA_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !keep.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ── 1. index.json — network-first, cache fallback ───────────
  if (url.pathname === '/data/index.json') {
    event.respondWith(
      fetch(event.request)
        .then(res  => { putInCache(DATA_CACHE, event.request, res); return res; })
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
    const m      = url.pathname.match(/\/data\/(\d{4}-\d{2}-\d{2})\.json$/);
    const isPast = m && m[1] < todayStr();

    if (isPast) {
      // Historical files are immutable — serve from cache forever once fetched
      event.respondWith(
        caches.open(DATA_CACHE).then(async cache => {
          const hit = await cache.match(event.request);
          if (hit) return hit;
          const res = await fetch(event.request);
          putInCache(DATA_CACHE, event.request, res);
          return res;
        })
      );
    } else {
      // Today's file — network-first so fresh updates appear immediately
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

  // ── 3. Shell (index.html, manifest.json) — network-first ────
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/manifest.json') {
    event.respondWith(
      fetch(event.request)
        .then(res => { putInCache(SHELL_CACHE, event.request, res); return res; })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // ── 4. Hashed app assets — NOT intercepted ───────────────────
  // app.*.css and app.*.js have `immutable` HTTP headers from Vercel;
  // the browser's HTTP cache handles them for 1 year without SW involvement.
  if (/^\/app\.[a-f0-9]+\.(css|js)$/.test(url.pathname)) {
    return; // let the browser handle it via HTTP cache
  }

  // ── 5. CDN resources (icon fonts) — cache-first ─────────────
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
