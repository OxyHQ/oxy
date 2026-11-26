import type { OxyRuntime } from './createOxyRuntime';

/**
 * The mounted provider's runtime, for code that runs outside React: a
 * bloom-data action that settles a write of the signed-in person reads the
 * account here and replaces it with the server's answer.
 *
 * The runtime stays the one owner of the session (ADR 0004); this is only the
 * way to reach it without a hook, as bloom-data's `currentStore()` is for the
 * account's store. With no provider mounted (a server render, a unit test with
 * no provider) there is none, and such code acts on nobody.
 */
let active: OxyRuntime | null = null;

/** The mounted provider's runtime, or `null` with none mounted. */
export function activeRuntime(): OxyRuntime | null {
  return active;
}

/**
 * Makes `runtime` the active one while its provider is mounted. The returned
 * function releases it again (unless another provider took over meanwhile).
 */
export function bindActiveRuntime(runtime: OxyRuntime): () => void {
  active = runtime;
  return () => {
    if (active === runtime) active = null;
  };
}
