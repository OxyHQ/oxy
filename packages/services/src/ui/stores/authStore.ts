import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { User } from '@oxyhq/core';
import type { OxyRuntime } from '../runtime';

/**
 * The signed-in user, as a zustand-shaped read/write surface.
 *
 * It used to BE a zustand store, and that made it a second owner of the
 * session: the provider wrote `user`/`isAuthenticated` here, `SessionClient`
 * wrote the same facts into its device state, and nothing reconciled them —
 * when they disagreed, which one was right was not answerable. It is now a
 * projection of the ONE `OxyRuntime` (ADR 0004): reads come off the runtime
 * snapshot and writes go into the runtime, so there is nothing left to drift.
 *
 * The zustand SHAPE is kept deliberately — `useAuthStore(selector)`,
 * `.getState()`, `.setState()`, `.subscribe()` — because a dozen call sites
 * across this package and the Commons app read the user out of band, from
 * mutation success handlers and cache helpers that are not inside a render.
 * Rewriting them is Phase 8's cut, not this one's.
 *
 * `fetchUser` and `lastUserFetch` are GONE rather than projected: they were a
 * five-minute profile cache with zero readers anywhere in the monorepo, and the
 * Query cache has owned that job since long before this change.
 */
export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  loginSuccess: (user: User) => void;
  loginFailure: (error: string) => void;
  logout: () => void;
  /** Replace the signed-in profile after a write (a rename, a new avatar). */
  setUser: (user: User) => void;
}

/** The subset of `AuthState` a caller may push back in through `setState`. */
export type AuthStatePatch = Partial<Pick<AuthState, 'user' | 'isLoading' | 'error'>>;

let boundRuntime: OxyRuntime | null = null;
let unbindRuntime: (() => void) | null = null;
const listeners = new Set<() => void>();

const loginSuccess = (user: User): void => {
  boundRuntime?.setAccount(user);
};

const loginFailure = (error: string): void => {
  boundRuntime?.batch(() => {
    boundRuntime?.setLoading(false);
    boundRuntime?.setError(error);
  });
};

const logout = (): void => {
  boundRuntime?.clearSession();
};

const setUser = (user: User): void => {
  boundRuntime?.setAccount(user);
};

const SIGNED_OUT: AuthState = Object.freeze({
  user: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
  loginSuccess,
  loginFailure,
  logout,
  setUser,
});

let state: AuthState = SIGNED_OUT;

function project(runtime: OxyRuntime | null): AuthState {
  if (runtime === null) {
    return SIGNED_OUT;
  }
  const snapshot = runtime.getSnapshot();
  return Object.freeze({
    user: snapshot.account,
    isAuthenticated: snapshot.account !== null,
    isLoading: snapshot.isLoading,
    error: snapshot.error?.message ?? null,
    loginSuccess,
    loginFailure,
    logout,
    setUser,
  });
}

function republish(): void {
  const next = project(boundRuntime);
  if (
    next.user === state.user &&
    next.isAuthenticated === state.isAuthenticated &&
    next.isLoading === state.isLoading &&
    next.error === state.error
  ) {
    return;
  }
  state = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * Point this surface at the provider's runtime. Called once by
 * `OxyRuntimeProvider`; the returned function detaches it again on unmount.
 *
 * With nothing bound, reads answer signed-out and writes are dropped. That is
 * the honest answer for the two places it happens — the SSR shim, and a unit
 * test poking the store with no provider mounted — and it is why binding is an
 * explicit call rather than a lazily-created default runtime, which is exactly
 * the fabricated-forever-loading runtime ADR 0004 deleted.
 */
export function bindAuthStoreToRuntime(runtime: OxyRuntime): () => void {
  unbindRuntime?.();
  boundRuntime = runtime;
  unbindRuntime = runtime.subscribe(republish);
  republish();
  return () => {
    if (boundRuntime !== runtime) {
      return;
    }
    unbindRuntime?.();
    unbindRuntime = null;
    boundRuntime = null;
    republish();
  };
}

const getState = (): AuthState => state;

const setState = (patch: AuthStatePatch): void => {
  boundRuntime?.batch(() => {
    if (patch.isLoading !== undefined) {
      boundRuntime?.setLoading(patch.isLoading);
    }
    if (patch.error !== undefined) {
      boundRuntime?.setError(patch.error);
    }
    if (patch.user !== undefined) {
      if (patch.user === null) {
        boundRuntime?.clearSession();
      } else {
        boundRuntime?.setAccount(patch.user);
      }
    }
  });
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function useAuthStoreHook<T>(selector: (state: AuthState) => T): T {
  // The selection is cached against the state object it came from, so a
  // selector returning a fresh object cannot make `useSyncExternalStore` see a
  // new value on every call and loop.
  const cache = useRef<{ state: AuthState; value: T } | null>(null);
  const getSelection = useCallback((): T => {
    const cached = cache.current;
    if (cached !== null && cached.state === state) {
      return cached.value;
    }
    const value = selector(state);
    cache.current = { state, value };
    return value;
  }, [selector]);
  return useSyncExternalStore(subscribe, getSelection, getSelection);
}

/**
 * Read the signed-in user. Zustand-shaped, projected from the runtime.
 *
 * A selector that builds an object must be wrapped in `useShallow` (as every
 * call site here already does) — otherwise a structurally-equal result reads as
 * a change on every publish.
 */
export const useAuthStore = Object.assign(useAuthStoreHook, {
  getState,
  setState,
  subscribe,
});
