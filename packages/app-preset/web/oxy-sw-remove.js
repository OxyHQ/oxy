/**
 * Written as `/sw.js` by `oxy-web-pwa --remove-sw`: retires this origin's
 * worker. The browser installs it on the next update check (it differs from the
 * worker it replaces), and on `activate` it deletes the Oxy caches and
 * unregisters itself. It answers no `fetch`, so open pages go to the network
 * at once (nothing reloads under the user) and the next load has no worker.
 * Shipping no `/sw.js` at all would not do this: a failed update check leaves
 * the old worker running.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('oxy-sw-')) await caches.delete(key);
      await self.registration.unregister();
    })(),
  );
});
