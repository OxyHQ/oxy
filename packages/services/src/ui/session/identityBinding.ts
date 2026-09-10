/**
 * Identity-bound sessions — the PLATFORM half of `sessionMode: 'identity'`.
 *
 * `@oxy.so/core` owns everything platform-agnostic about an identity-bound
 * session: the pin store shapes, `resolveIdentityPin`,
 * `establishIdentitySession`, and the pinned cold-boot / re-mint lanes. What it
 * deliberately leaves out is WHICH pin store a given runtime should use, so this
 * module supplies it — web `localStorage` vs the same native SecureStore adapter
 * the device credential already persists through — and adds the one piece of
 * state the provider needs on top: a memoised, SYNCHRONOUSLY readable pinned
 * account id.
 *
 * Why the memo matters: `SessionClient.getPinnedAccountId` is a synchronous read
 * on the socket/apply path, while resolving the pin is asynchronous (a storage
 * read plus a keychain read, through `resolveIdentityPin`). The provider
 * resolves it before the cold boot and after every (re-)established identity
 * session; every read after that is free.
 */
import {
  createNativeIdentityPinStore,
  createWebIdentityPinStore,
  resolveIdentityPin,
  type IdentityBinding,
} from '@oxy.so/core';
import { isReactNative } from '../utils/storageHelpers';
import { createNativeSecureKeyValueStorage } from './nativeSecureStorage';

/**
 * The provider-scoped identity binding: the core {@link IdentityBinding} handed
 * to the cold boot and the re-mint handler, plus the resolved pin the projection
 * and `SessionClient` bind to.
 */
export interface IdentitySessionBinding {
  /** Handed to `runSessionColdBoot` and `installAuthRefreshHandler`. */
  readonly binding: IdentityBinding;
  /**
   * The last resolved pinned account id, read synchronously. `null` until the
   * first resolve lands, and after a resolve that found no usable pin.
   */
  getPinnedAccountId(): string | null;
  /**
   * Resolve the pin, reusing the memo once a pinned account is known.
   * Concurrent callers share one in-flight resolve.
   */
  ensurePinnedAccountId(): Promise<string | null>;
  /**
   * Drop the memo and re-resolve. Used after a lane that may have rewritten or
   * cleared the pin (the cold boot, or a re-established identity session).
   */
  refreshPinnedAccountId(): Promise<string | null>;
}

/**
 * Thrown by every account-graph mutation while the provider runs in
 * `sessionMode: 'identity'`.
 *
 * An identity-bound app's user is the owner of the local identity key — fixed,
 * for the lifetime of that key. Switching it is not a temporarily-unavailable
 * operation that could be retried, it is not part of this mode's contract at
 * all, so the surfaces reject loudly rather than resolving to a no-op that would
 * read to the caller as a successful switch.
 */
export class IdentityBoundSessionError extends Error {
  override readonly name = 'IdentityBoundSessionError';
  readonly code = 'identity_bound_session';
  constructor(readonly operation: string) {
    super(
      `"${operation}" is unavailable while the session is identity-bound (sessionMode: "identity"): this app authenticates as the owner of the local identity key and cannot switch accounts.`,
    );
  }
}

/**
 * Build the identity binding for this runtime. Called ONCE per provider mount,
 * and ONLY when `sessionMode: 'identity'` — account-mode providers never
 * construct a pin store.
 */
export function createIdentitySessionBinding(): IdentitySessionBinding {
  const pinStore = isReactNative()
    ? createNativeIdentityPinStore(createNativeSecureKeyValueStorage())
    : createWebIdentityPinStore();
  const binding: IdentityBinding = { pinStore };

  // Only a RESOLVED (non-null) pin is memoised. A `null` outcome is either "not
  // pinned yet" or an indeterminate key read (locked keychain), and caching
  // either one would leave this client permanently unpinned for the rest of the
  // process — the exact state in which it would start following the device's
  // mutable active account.
  let pinnedAccountId: string | null = null;
  let inFlight: Promise<string | null> | null = null;

  const resolve = (): Promise<string | null> => {
    if (!inFlight) {
      inFlight = resolveIdentityPin(binding)
        .then((pin) => {
          pinnedAccountId = pin?.accountId ?? null;
          return pinnedAccountId;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  return {
    binding,
    getPinnedAccountId: () => pinnedAccountId,
    ensurePinnedAccountId: () =>
      pinnedAccountId !== null ? Promise.resolve(pinnedAccountId) : resolve(),
    refreshPinnedAccountId: () => {
      pinnedAccountId = null;
      return resolve();
    },
  };
}
