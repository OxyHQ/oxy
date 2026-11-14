/**
 * Registers the app's `/sw.js`. `oxy-web-pwa` copies this file into the web
 * export and links it from every HTML page with `defer`, as a file and not an
 * inline script so an app's CSP needs no exception.
 *
 * Registering a URL that is already registered is a no-op, so this coexists
 * with an app that registers `/sw.js` itself (web push setup). An app hydrates
 * after `load` has often fired, and a `load` listener added then never runs,
 * so the page's state is checked first. Failure is silent: the app works
 * without a worker.
 *
 * First visit: the page loads its bundles and route chunks before the worker
 * controls it, so none of them goes through the worker's cache. When the worker
 * takes over, this sends it the same-origin files the page has loaded so far
 * (`OXY_SW_STORE`), and the app works offline from the first visit.
 *
 * Updates: `updateViaCache: 'none'` makes every update check fetch `/sw.js` and
 * `/oxy-sw-base.js` past the HTTP cache. The browser checks on each navigation,
 * but an installed app can stay open for days without one, so a page that
 * comes back to the foreground checks too, at most once an hour.
 */
(() => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const HOUR = 60 * 60 * 1000;
  let checked = Date.now();
  const sendLoaded = () => {
    const worker = navigator.serviceWorker.controller;
    if (!worker || typeof performance === 'undefined') return;
    const urls = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(`${location.origin}/`));
    worker.postMessage({ type: 'OXY_SW_STORE', urls });
  };
  if (!navigator.serviceWorker.controller)
    navigator.serviceWorker.addEventListener('controllerchange', sendLoaded, { once: true });
  const register = () => {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState !== 'visible' || Date.now() - checked < HOUR) return;
          checked = Date.now();
          registration.update().catch(() => {});
        });
      })
      .catch(() => {});
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
})();
