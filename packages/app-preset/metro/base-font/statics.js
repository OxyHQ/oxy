/** Properties a function carries that are not a component's statics. */
const OWN = new Set(['length', 'name', 'prototype', 'caller', 'arguments', '$$typeof', 'render']);

/**
 * `host` with `source`'s statics (`TextInput.State`, `displayName`), so the
 * replacement is the component an app imported in every way it reads one.
 */
function withStatics(source, host) {
  for (const key of Object.getOwnPropertyNames(source)) {
    if (OWN.has(key)) continue;
    Object.defineProperty(host, key, Object.getOwnPropertyDescriptor(source, key));
  }
  return host;
}

module.exports = { withStatics };
