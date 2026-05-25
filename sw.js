// AI Digest — Service Worker v5 (self-destruct)
//
// Previous SW versions caused fetch hangs due to response.clone()
// interactions with the CSP header. This version immediately
// unregisters itself and clears all caches on install/activate,
// then gets out of the way. No fetch interception.

self.addEventListener('install', event => {
  // Skip waiting so this SW activates immediately over v4
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Delete every cache this SW family ever created
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      // Take control of all open clients immediately
      await self.clients.claim();
      // Tell every open tab to reload so they get fresh data without the SW
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.postMessage({ type: 'SW_SELF_DESTRUCT' });
      }
      // Unregister this SW — after this runs, no SW will be active
      await self.registration.unregister();
    })()
  );
});

// No fetch handler — all requests go straight to the network.
