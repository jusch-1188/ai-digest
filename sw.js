// AI Digest — Service Worker
// Caches: shell (index.html, assets) + last 7 days of data files
// Strategy: cache-first for data, network-first for shell

const SHELL_CACHE  = 'ai-digest-shell-v1';
const DATA_CACHE   = 'ai-digest-data-v1';
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
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_URLS))
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
      .then(() => {
        // Pre-cache last 7 days of data in background
        caches.open(DATA_CACHE).then(cache => {
          last7Days().forEach(url => {
            fetch(url).then(res => { if (res.ok) cache.put(url, res); }).catch(() => {});
          });
        });
        return self.clients.claim();
      })
  );
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
          if (res.ok) cache.put(event.request, res.clone());
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
          caches.open(SHELL_CACHE).then(cache => cache.put(event.request, res.clone()));
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
            caches.open(SHELL_CACHE).then(c => c.put(event.request, res.clone()));
          }
          return res;
        }).catch(() => cached || new Response('', { status: 503 }));
      })
    );
  }
});
