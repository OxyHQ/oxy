import { useEffect, useMemo } from 'react';
import type { Href } from 'expo-router';
import { useOxy } from '@oxy.so/services';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyManager } from '@oxy.so/core';
import type { IdentityStatus } from '@oxy.so/core';
import {
  getOnboardingCompleteFromStorage,
  getOnboardingFlowFromStorage,
  persistOnboardingComplete,
  type OnboardingFlow,
} from './identity/identityStore';

export type OnboardingStatus =
  | 'checking'
  | 'none'
  | 'in_progress'
  | 'complete'
  | 'recovery'
  | 'unavailable';

export interface OnboardingState {
  status: OnboardingStatus;
  needsAuth: boolean;
  isLoading: boolean;
  hasIdentity: boolean;
  hasUsername: boolean;
  /**
   * True ONLY when the LOCAL identity probe verdict is `present` (a healthy,
   * round-tripping key pair on THIS device) — narrower than `hasIdentity`, which
   * also counts an active session. The shared-identity boot backfill gates on
   * this so it never runs on a fresh install, a `lost`/`unavailable` device, or a
   * session-only (keys-not-locally-confirmed) state.
   */
  identityPresent: boolean;
  /**
   * True while the SDK's device-first cold boot is still resolving the session
   * (`!isAuthResolved`). This is SEPARATE from routing — routing is decided from
   * local reads only and never waits on the session — but consumers that want to
   * show a "still connecting…" hint can read this.
   */
  isSessionResolving: boolean;
  /**
   * Why the identity could not be resolved to a healthy `present`, when the
   * status is a non-happy terminal: `'locked'` (storage threw — a locked keychain
   * → retry UI) or `'lost'` (a marker records a prior identity but the keys are
   * gone → recovery ladder). `null` for every other status.
   */
  unavailableReason: 'locked' | 'lost' | null;
  /** Persisted wizard choice; `null` until read or if unset (defaults to create on resume). */
  onboardingFlow: OnboardingFlow | null;
}

/**
 * React Query key for the shared local-identity probe. Every consumer of
 * `useOnboardingStatus` reads THIS key, so `KeyManager.getIdentityStatus()` runs
 * once per app session and all consumers share one deduped result + one loading
 * state. Identity mutations (create / import / delete / restore) invalidate this
 * key — at their call sites AND via the `subscribeIdentityChanged` subscription
 * in `AppStackContent` — so the probe re-runs exactly when the answer can change.
 */
export const ONBOARDING_IDENTITY_QUERY_KEY = ['onboarding', 'identity'] as const;

/**
 * React Query key for the LOCAL, offline-safe "onboarding complete" milestone
 * (`getOnboardingCompleteFromStorage`). Read once per app session and shared by
 * every consumer. Identity mutations invalidate it so it re-reads exactly when
 * the answer can change; genuine online completion writes it directly via
 * `queryClient.setQueryData` below.
 */
export const ONBOARDING_COMPLETE_QUERY_KEY = ['onboarding', 'complete'] as const;

/** Shared React Query key for the persisted create-vs-import wizard choice. */
export const ONBOARDING_FLOW_QUERY_KEY = ['onboarding', 'flow'] as const;

/** Resume path for an in-progress onboarding wizard. */
export function getOnboardingResumeHref(flow: OnboardingFlow | null): Href {
  return flow === 'import'
    ? '/(auth)/import-identity/username'
    : '/(auth)/create-identity';
}

/**
 * The identity verdict routing keys off of, with `unavailable` removed: the
 * queryFn THROWS on `unavailable` so a storage failure never becomes cached
 * `data` — it must always re-read on the next attempt.
 */
type IdentityVerdict = Exclude<IdentityStatus, { state: 'unavailable' }>;

/**
 * Typed wrapper thrown from the identity queryFn when `getIdentityStatus`
 * reports `unavailable` (storage threw / keychain locked). Throwing — rather
 * than returning the `unavailable` verdict as data — is deliberate: React Query
 * retries (bounded), keeps any previously-resolved verdict as sticky `data`, and
 * only surfaces the error (→ `unavailable` status) when there is NO cached
 * verdict to fall back on.
 */
class IdentityProbeUnavailableError extends Error {
  readonly name = 'IdentityProbeUnavailableError';
  readonly cause?: unknown;
  constructor(cause: unknown) {
    super('Identity storage is unavailable');
    this.cause = cause;
  }
}

/**
 * Centralized hook for managing onboarding state — a LOCAL-FIRST routing machine.
 *
 * ── The state machine ──────────────────────────────────────────────────────
 * Routing is decided PURELY from local reads (the on-device identity verdict +
 * the offline-safe onboarding milestone). `isAuthResolved` / the SDK's loading
 * flag appear NOWHERE in the decision — session restore/mint upgrades the status
 * in the background and can never gate, delay, or downgrade the local verdict.
 *
 * Decision order (first match wins):
 *   1. local queries still resolving                     → 'checking'
 *      (bounded: local reads + ≤~2.25s of identity retries)
 *   2. isAuthenticated && user                           → username ? 'complete'
 *                                                          : 'in_progress'
 *      (an active session is authoritative proof identity exists)
 *   3. identity probe errored, retries exhausted, NO
 *      cached verdict                                    → 'unavailable'
 *      (locked keystore → neutral retry UI, NEVER welcome/create)
 *   4. verdict 'lost' (marker present, keys gone)        → 'recovery'
 *      (corruption/keystore death → recovery ladder, NEVER welcome/create)
 *   5. verdict 'absent' (no keys, no marker)             → 'none'
 *      (a genuine fresh device — the ONLY path to welcome/create)
 *   6. verdict 'present'                                 → milestone ? 'complete'
 *                                                          : 'in_progress'
 *   needsAuth = status !== 'complete'
 *
 * ── Why this is safe against identity-loss ─────────────────────────────────
 * The old machine flattened a storage THROW into "no identity" and blocked
 * routing on the network cold boot, so a momentarily-locked keychain (or a
 * corruption-deleted key) looked identical to a fresh install and could route a
 * real user into create-identity. Now: `getIdentityStatus` distinguishes
 * `present` / `absent` / `lost` / `unavailable`; a throw becomes `unavailable`
 * (retry UI) and is NEVER cached; a marker-backed `lost` becomes `recovery`; and
 * only a genuine `absent` (no keys AND no marker) reaches `none`/create.
 *
 * ── Invariants ─────────────────────────────────────────────────────────────
 *   1. An active session (`isAuthenticated && user`) is decided BEFORE any of
 *      the terminal verdicts, so a transient local false-negative during cold
 *      start can never flash the welcome screen at a signed-in returning user.
 *   2. Verdicts are sticky-upward: React Query retains the last resolved `data`
 *      across a failing refetch (`staleTime: Infinity`), so a later transient
 *      probe failure can NEVER displace a cached `present` with `unavailable`.
 *   3. The probe re-runs only when the answer can actually change — an identity
 *      mutation invalidates `ONBOARDING_IDENTITY_QUERY_KEY` (at the mutation call
 *      site or through the `subscribeIdentityChanged` subscription).
 */
export function useOnboardingStatus(): OnboardingState {
  const { user, isAuthenticated, isAuthResolved } = useOxy();
  const queryClient = useQueryClient();

  const identityQuery = useQuery({
    queryKey: ONBOARDING_IDENTITY_QUERY_KEY,
    queryFn: async (): Promise<IdentityVerdict> => {
      const verdict = await KeyManager.getIdentityStatus();
      if (verdict.state === 'unavailable') {
        // Never let a storage failure become cached data — throw so React Query
        // retries and, only when there is no prior verdict to fall back on,
        // surfaces the error as the `unavailable` status.
        throw new IdentityProbeUnavailableError(verdict.cause);
      }
      return verdict;
    },
    // Verdicts only change on explicit identity mutations, which invalidate the
    // key — so never auto-refetch a resolved verdict.
    staleTime: Infinity,
    // Storage can be transiently locked at cold start. Retry a couple of times
    // with short backoff (250ms, then 1s) before giving up to `unavailable`.
    retry: 2,
    retryDelay: (attemptIndex) => (attemptIndex === 0 ? 250 : 1000),
  });

  // The LOCAL, offline-safe "onboarding complete" milestone — the signal that
  // lets a RETURNING user reach the vault with ZERO network. A plain storage
  // read (self-heals from the identity marker), never a network call, so an
  // existing identity is never hidden behind a failed session mint.
  // `getOnboardingCompleteFromStorage` catches its own storage errors (→ false),
  // so it never throws and needs no retry.
  const completeQuery = useQuery({
    queryKey: ONBOARDING_COMPLETE_QUERY_KEY,
    queryFn: getOnboardingCompleteFromStorage,
    staleTime: Infinity,
    retry: false,
  });

  const flowQuery = useQuery({
    queryKey: ONBOARDING_FLOW_QUERY_KEY,
    queryFn: getOnboardingFlowFromStorage,
    staleTime: Infinity,
    retry: false,
  });

  // ── Derived local read state ───────────────────────────────────────────────
  const identityVerdict = identityQuery.data;
  // Still resolving: no verdict yet AND retries not yet exhausted.
  const isIdentityResolving = identityVerdict === undefined && !identityQuery.isError;
  // Exhausted retries with NO cached verdict → storage genuinely unavailable.
  const isIdentityUnavailable = identityVerdict === undefined && identityQuery.isError;

  const onboardingComplete = completeQuery.data === true;
  const isCompleteResolving = completeQuery.data === undefined;
  const onboardingFlow = flowQuery.data ?? null;
  const isFlowResolving = flowQuery.data === undefined;

  // Persist the monotonic onboarding-complete milestone the moment onboarding
  // genuinely completes ONLINE (a live session whose user has a username). This
  // is what lets the NEXT cold start route a returning user to the vault with no
  // network. Guarded on the cached flag so it writes at most once per identity;
  // `setQueryData` reflects it immediately for the current session. Never clears
  // it here — creation/import own the reset (see `useIdentity`).
  useEffect(() => {
    if (!isAuthenticated || !user?.username) return;
    if (completeQuery.data === true) return;
    void persistOnboardingComplete(true);
    queryClient.setQueryData(ONBOARDING_COMPLETE_QUERY_KEY, true);
  }, [isAuthenticated, user?.username, completeQuery.data, queryClient]);

  const status = useMemo<OnboardingStatus>(() => {
    // 1. Local reads still resolving — neutral backdrop, never a premature verdict.
    if (isIdentityResolving || isCompleteResolving || isFlowResolving) {
      return 'checking';
    }

    // 2. An active session is authoritative proof identity material exists on the
    //    device. Decided BEFORE the terminal verdicts so a transient local
    //    false-negative can never flash welcome/recovery at a signed-in user.
    if (isAuthenticated && user) {
      return user.username ? 'complete' : 'in_progress';
    }

    // 3. The probe threw and exhausted its retries with no cached verdict — the
    //    keystore is locked/unreadable RIGHT NOW. Route to a neutral retry UI,
    //    NEVER to welcome/create (a locked keychain is not a blank device).
    if (isIdentityUnavailable) {
      return 'unavailable';
    }

    // Past the guards above, a verdict is always present (it can only be
    // undefined while resolving or while unavailable, both handled). The
    // defensive fallback keeps this total for the type-checker.
    if (!identityVerdict) {
      return 'checking';
    }

    // 4. Keys are gone but a marker records a prior identity → corruption /
    //    keystore death. Route to recovery, NEVER to create.
    if (identityVerdict.state === 'lost') {
      return 'recovery';
    }

    // 5. No keys AND no marker → a genuine fresh device. The ONLY path to
    //    welcome/create.
    if (identityVerdict.state === 'absent') {
      return 'none';
    }

    // 6. Identity present locally but no live session (offline / session not yet
    //    minted). Decide from the LOCAL milestone: completed before → returning
    //    user → vault; never completed → resume the wizard.
    return onboardingComplete ? 'complete' : 'in_progress';
  }, [
    isIdentityResolving,
    isCompleteResolving,
    isFlowResolving,
    isIdentityUnavailable,
    identityVerdict,
    onboardingComplete,
    isAuthenticated,
    user,
  ]);

  const needsAuth = status !== 'complete';

  const unavailableReason: 'locked' | 'lost' | null =
    status === 'unavailable' ? 'locked' : status === 'recovery' ? 'lost' : null;

  return {
    status,
    needsAuth,
    // "Loading" for routing purposes is exactly the still-resolving window; the
    // separate `isSessionResolving` covers the background session mint.
    isLoading: status === 'checking',
    // An active session implies identity exists — keep this in lockstep with the
    // `status` invariant above so consumers that gate on `hasIdentity` don't fall
    // out of sync during the transient false-negative window.
    hasIdentity: (isAuthenticated && Boolean(user)) || identityVerdict?.state === 'present',
    hasUsername: Boolean(isAuthenticated && user?.username),
    identityPresent: identityVerdict?.state === 'present',
    isSessionResolving: !isAuthResolved,
    unavailableReason,
    onboardingFlow,
  };
}
