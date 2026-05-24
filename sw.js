// AI Digest — Service Worker v2
// Fix: clone response IMMEDIATELY before any async operations

const SHELL_CACHE  = 'ai-digest-shell-v2';   // bumped — clears old bad cache
const DATA_CACHE   = 'ai-digest-data-v2';    // bumped — clears old bad cache
const SHELL_URLS   = ['/', '/index.html', '/manifest.json'];
const DATA_DAYS    = 7;

// ── Helpers ─────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function last7Days() {
  const today = todayStr();
  const urls = [];
  for (let i = 0; i < DATA_DAYS; i++) {
    const d = addDays(today, -i);
    urls.push(`/data/${d}.json`);
  }
  return urls;
}

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', event => {
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
        keys.filter(k => !validCaches.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
  // Pre-cache last 7 days of data in background (after activation)
  // Use clone() so cache.put doesn't consume the only copy
  caches.open(DATA_CACHE).then(cache => {
    last7Days().forEach(url => {
      fetch(url).then(res => {
        if (res.ok) cache.put(url, res.clone());  // clone before put
      }).catch(() => {});
    });
  });
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Data files: cache-first, then network
  if (url.pathname.startsWith('/data/') && url.pathname.endsWith('.json')) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const res = await fetch(event.request);
          if (res.ok) {
            cache.put(event.request, res.clone()); // clone BEFORE returning res
          }
          return res;
        } catch {
          return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
        }
      })
    );
    return;
  }

  // Shell files: network-first, fall back to cache
  if (SHELL_URLS.includes(url.pathname) || url.pathname === '/sw.js') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone(); // clone IMMEDIATELY, synchronously, before any await
          caches.open(SHELL_CACHE).then(cache => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // External resources (CDN fonts/icons): cache-first
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res.ok) {
            const clone = res.clone(); // clone IMMEDIATELY before returning res
            caches.open(SHELL_CACHE).then(c => c.put(event.request, clone));
          }
          return res;
        }).catch(() => new Response('', { status: 503 }));
      })
    );
  }
});
