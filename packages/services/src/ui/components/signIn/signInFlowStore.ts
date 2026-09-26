/**
 * Where the account dialog's sign-in and sign-up screens keep their step while
 * the dialog is open.
 *
 * The dialog is a responsive surface: Bloom renders it as a bottom sheet below
 * `md` and as a centered card from `md`, two different trees, so crossing the
 * breakpoint (a resized window, a rotated tablet) remounts the screen inside.
 * Held in component state, the step went with it: a person on "Two-step
 * verification" found the dialog back at "Sign in", their emailed code spent.
 * The step lives here instead, per account-dialog controller, and is dropped
 * when the dialog closes (`OxyContext`) or the flow ends. In memory only — the
 * request secret it holds never touches storage.
 */

const flows = new WeakMap<object, Map<string, unknown>>();

/** The saved state of flow `key` in the dialog `owner` drives, if any. */
export function readSignInFlow<T>(owner: object | null | undefined, key: string): T | undefined {
  if (!owner) return undefined;
  return flows.get(owner)?.get(key) as T | undefined;
}

/** Save the state of flow `key`; `undefined` drops it. */
export function writeSignInFlow(owner: object | null | undefined, key: string, value: unknown): void {
  if (!owner) return;
  let saved = flows.get(owner);
  if (value === undefined) {
    saved?.delete(key);
    return;
  }
  if (!saved) {
    saved = new Map();
    flows.set(owner, saved);
  }
  saved.set(key, value);
}

/** Drop every flow the dialog `owner` drives: it closed. */
export function clearSignInFlows(owner: object | null | undefined): void {
  if (owner) flows.delete(owner);
}
