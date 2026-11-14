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
 * Updates: `updateViaCache: 'none'` makes every update check fetch `/sw.js` and
 * `/oxy-sw-base.js` past the HTTP cache. The browser checks on each navigation,
 * but an installed app can stay open for days without one, so a page that
 * comes back to the foreground checks too, at most once an hour.
 */
(() => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const HOUR = 60 * 60 * 1000;
  let checked = Date.now();
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
