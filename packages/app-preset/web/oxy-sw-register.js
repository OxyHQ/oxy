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
 */
(() => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
})();
