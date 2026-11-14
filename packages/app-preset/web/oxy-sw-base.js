/**
 * The Oxy base service worker: an offline app shell and a cache of this
 * origin's public, content-hashed files, and nothing else.
 *
 * `oxy-web-pwa` copies this file into every Oxy web export as
 * `/oxy-sw-base.js` and, when the app has no `public/sw.js`, writes a `/sw.js`
 * that only imports it. An app with its own worker (web push) opts in with
 * `importScripts('/oxy-sw-base.js');` as its first line. An app whose worker
 * already answers `fetch` must not import it: the first `respondWith` wins.
 *
 * Strategies (ported from Inbosh's worker, which paid for each rule):
 *
 * - Navigation: network-first, so a deploy is visible on the next load. The
 *   one SPA shell is stored once under `/index.html` and served offline.
 * - Same-origin static files (`/_expo/`, `/assets/`, images, fonts, JS, CSS):
 *   stale-while-revalidate. Metro hashes these names, so an entry is never
 *   stale in content, and chunks of the previous deploy stay loadable for a
 *   page that is still running it.
 * - Everything else is left to the browser, never stored and never served
 *   from here: cross-origin requests (every Oxy API), non-GET, `/api/`, any
 *   request carrying `Authorization`, range requests, and `private` or
 *   `no-store` responses. (`credentials` is no test: every navigation is
 *   `include`, and a same-origin request sends cookies either way.)
 *   Private responses must never be cached by URL: Inbosh once served one
 *   signed-in user's API response to the next.
 *
 * Updates. `__OXY_SW_VERSION__` is replaced by `oxy-web-pwa` with a hash of
 * the export, so this file's bytes change on every deploy; the browser compares
 * imported scripts byte for byte, so it installs the new worker, which takes
 * over at once (`skipWaiting`, `clients.claim`). App code is never stale: a
 * navigation is network-first, so the next load or reload runs the new deploy,
 * and a page still running the old one keeps loading its own chunks.
 *
 * Cleanup. The cache name is fixed (`oxy-sw-v1`), not per deploy: hashed
 * chunks never collide, so one cache holds both deploys and a tab opened
 * before a deploy can still lazy-load the chunks it was built with (the server
 * no longer has them). It holds at most 150 entries, oldest dropped first, the
 * shell never. `activate` deletes every other `oxy-sw-*` cache, so bumping the
 * name here (when a strategy changes what a cached entry means) clears old
 * entries everywhere on the next deploy. `oxy-web-pwa --remove-sw` retires the
 * worker and its caches entirely.
 */
(() => {
  if (self.__oxySwBase) return;
  self.__oxySwBase = true;

  const VERSION = '__OXY_SW_VERSION__';
  const CACHE_PREFIX = 'oxy-sw-';
  const CACHE_NAME = `${CACHE_PREFIX}v1`;
  self.__oxySwVersion = VERSION;
  const SHELL_KEY = '/index.html';
  const MAX_ENTRIES = 150;
  const STATIC_FILE = /\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|ico|webp|avif|wasm)$/i;

  const offline = () => new Response('Offline', { status: 503, statusText: 'Service Unavailable' });

  self.addEventListener('install', (event) => {
    event.waitUntil(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.add(new Request(SHELL_KEY, { cache: 'reload' })))
        .catch(() => {
          // Non-fatal: the shell is stored on the first navigation instead.
        }),
    );
    self.skipWaiting();
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
              .map((key) => caches.delete(key)),
          ),
        )
        .then(() => self.clients.claim()),
    );
  });

  self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  });

  /** `'navigation'`, `'static'`, or `null` for a request this worker leaves alone. */
  function strategyFor(request) {
    if (request.method !== 'GET') return null;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return null;
    if (url.pathname.startsWith('/api/')) return null;
    if (request.headers.has('authorization') || request.headers.has('range')) return null;
    if (request.mode === 'navigate') return 'navigation';
    if (
      url.pathname.startsWith('/_expo/') ||
      url.pathname.startsWith('/assets/') ||
      STATIC_FILE.test(url.pathname)
    )
      return 'static';
    return null;
  }

  /** Only a complete, same-origin, storable response is ever cached. */
  function cacheable(response) {
    if (!response?.ok || response.status !== 200 || response.type !== 'basic') return false;
    const control = response.headers.get('cache-control') || '';
    return !/no-store|private/i.test(control);
  }

  async function trim(cache) {
    const keys = await cache.keys();
    const excess = keys.length - MAX_ENTRIES;
    for (let i = 0, dropped = 0; i < keys.length && dropped < excess; i++) {
      if (new URL(keys[i].url).pathname === SHELL_KEY) continue;
      await cache.delete(keys[i]);
      dropped++;
    }
  }

  async function navigation(request) {
    try {
      const response = await fetch(request);
      if (
        cacheable(response) &&
        (response.headers.get('content-type') || '').includes('text/html')
      ) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(SHELL_KEY, response.clone());
      }
      return response;
    } catch {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(SHELL_KEY)) || offline();
    }
  }

  async function staleWhileRevalidate(event) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    const network = fetch(event.request)
      .then(async (response) => {
        if (cacheable(response)) {
          await cache.put(event.request, response.clone());
          await trim(cache);
        }
        return response;
      })
      .catch(() => null);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    return (await network) || offline();
  }

  self.addEventListener('fetch', (event) => {
    const strategy = strategyFor(event.request);
    if (strategy === 'navigation') event.respondWith(navigation(event.request));
    else if (strategy === 'static') event.respondWith(staleWhileRevalidate(event));
  });

  self.__oxySwBaseInternals = { strategyFor, cacheable, trim, CACHE_NAME, SHELL_KEY, MAX_ENTRIES };
})();
