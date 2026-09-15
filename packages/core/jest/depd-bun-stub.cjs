/**
 * No-op stand-in for `depd`, used ONLY when Jest itself runs on the Bun runtime
 * (see `jest.config.cjs`).
 *
 * `depd` — which Express loads for its deprecation warnings — reads V8
 * `CallSite` objects (`callSite.getFileName()`) at require time. Under Jest on
 * Bun those call sites come from JavaScriptCore and lack that method, so
 * `require('express')` throws before any test can run. Deprecation warnings
 * are irrelevant to every assertion here; Node (CI) always loads the real one.
 */
function depd() {
  function deprecate() {}
  deprecate.function = (fn) => fn;
  deprecate.property = () => undefined;
  return deprecate;
}

module.exports = depd;
