import { create } from 'zustand';

/**
 * The machine credential the playground is currently holding, in memory.
 *
 * ## Why this is a store and not component state
 *
 * There are two ways a key reaches the playground and they have to be ONE code
 * path, or the second is a copy of the first that will drift:
 *
 *  1. the user pastes an `oxy_sk_…` into the playground itself, and
 *  2. they have just created or rotated a credential in an application's
 *     Credentials tab, where the secret is visible for the only time it ever will
 *     be, and press "try this key in the playground".
 *
 * (2) crosses a route boundary, and every mechanism for carrying a value across
 * one either persists it or puts it in a URL. Router `state` goes into
 * `history.state`, which the browser serialises and keeps in session history; a
 * search parameter goes into the address bar, the referrer and every log between
 * here and there. A module-scoped store is the only carrier that does NEITHER.
 *
 * ## What this store deliberately does not do
 *
 * No `persist` middleware, no `localStorage`, no `sessionStorage`. The value
 * lives in the tab's memory and is gone on reload, on a new tab, and whenever the
 * user clears it. It is never a React Query key, never part of a cache entry,
 * never logged and never in a URL — `use-playground.ts` reads it, puts it in one
 * `Authorization` header and keeps no copy.
 *
 * A zustand store rather than a module-level `let` because a plain mutable module
 * variable read during render is exactly the stale-read hazard the React Compiler
 * rules forbid: the compiler may memoise the read and never see the write. This
 * store subscribes through `useSyncExternalStore`, so a component reading it is
 * reactive and correct under compilation.
 */
interface PlaygroundKeyState {
  /** The full bearer string, or `''` when the playground holds none. */
  readonly apiKey: string;
  setApiKey: (apiKey: string) => void;
}

export const usePlaygroundKey = create<PlaygroundKeyState>()((set) => ({
  apiKey: '',
  setApiKey: (apiKey) => set({ apiKey }),
}));
