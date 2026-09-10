/**
 * React Query + mutation wrappers around the user's personal data NODE (Fase 5).
 *
 * A user's node is the decentralised store that holds the authentic copy of their
 * signed-record chain; Oxy keeps a fast, verified projection so reads are always
 * instant while the node stays the source of truth. The SDK surface lives on
 * `@oxy.so/core`'s nodes mixin:
 *
 *  - `getMyNode()` → the caller's cached {@link UserNodeStatus} (or `null`).
 *  - `provisionManagedVault()` → ask Oxy to operate a MANAGED vault.
 *  - `registerNode(input)` → register a SELF-HOSTED node (signs on-device).
 *  - `removeMyNode()` → revoke the registration.
 *  - `notifyNodeIngest(userId)` → an unauthenticated re-pull HINT ("Sync now").
 *
 * `useMyNode` mirrors the offline-first behaviour of `usePersonhood` /
 * `useCredentials`: a previously-resolved status is served from the in-memory
 * cache immediately and survives going offline, under a `civic`-namespaced key so
 * it never collides with the SDK's account/session caches. The three mutations
 * mirror `useVouch` / `useIssueCredential`: a hand-rolled state machine that runs
 * the device biometric gate (where the operation signs or mutates) BEFORE calling
 * the SDK, classifies the server rejection into a friendly code, and invalidates
 * the shared node query so the status view refreshes. `notifyNodeIngest` is an
 * unauthenticated fire-and-forget hint, so `useSyncNode` does NOT gate it.
 *
 * NATIVE-ONLY for the signing path (`registerNode` signs with the on-device
 * identity key and throws on web); the reads, managed provision, revoke, and sync
 * hint are plain authenticated/public requests.
 */

import { useCallback, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type { RegisterNodeInput, UserNodeStatus } from '@oxy.so/core';
import { authenticate } from '@/lib/biometricAuth';

/** Build the shared per-user node query key (read + mutation invalidation share it). */
export function nodeQueryKey(userId: string | null): (string | null)[] {
  return ['civic', 'node', userId];
}

/** Keep a resolved status for a day so the offline view has something to show
 *  after the short freshness window lapses. */
const NODE_STALE_TIME_MS = 60 * 1000;
const NODE_GC_TIME_MS = 24 * 60 * 60 * 1000;

/**
 * Friendly, localizable classification of a node mutation rejection.
 *  - `not_authenticated`  — no signed-in user (the SDK guard fired pre-network).
 *  - `managed_unavailable`— Oxy's managed-vault fleet is unconfigured (503).
 *  - `invalid_endpoint`   — the server rejected the endpoint, so the registration
 *                           record stored but no node materialized.
 *  - `user_not_found`     — the resolved owner no longer exists.
 *  - `generic`            — transport failures / unmodelled reasons.
 */
export type NodeErrorCode =
  | 'not_authenticated'
  | 'managed_unavailable'
  | 'invalid_endpoint'
  | 'user_not_found'
  | 'generic';

/**
 * Classify a thrown node-mutation error. The SDK's `handleError` preserves the
 * server message and attaches a numeric `status`, so this reads the 503 from the
 * managed-vault config-unavailable answer and otherwise matches the stable
 * message fragments — anything else collapses to `'generic'`, so a screen can
 * always do `t('civic.nodes.errors.' + code)` and land on a real string.
 */
export function nodeErrorCode(error: unknown): NodeErrorCode {
  const status =
    typeof (error as { status?: unknown } | null)?.status === 'number'
      ? (error as { status: number }).status
      : undefined;
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();

  if (msg.includes('no authenticated user') || msg.includes('sign in before')) {
    return 'not_authenticated';
  }
  if (status === 503 || msg.includes('managed vaults are not available')) {
    return 'managed_unavailable';
  }
  if (msg.includes('could not be materialized')) {
    return 'invalid_endpoint';
  }
  if (msg.includes('user not found')) {
    return 'user_not_found';
  }
  return 'generic';
}

/** Resolve the current user id the same way every civic hook does. */
function useCurrentUserId(): string | null {
  const { user, oxyServices } = useOxy();
  return user?.id ?? oxyServices?.getCurrentUserId?.() ?? null;
}

/**
 * Query the CURRENT user's node status (the "Your data node" screen).
 *
 * Resolves through `getMyNode()` (which derives the subject from the session) and
 * keys the result by the current user id so the mutations can invalidate it.
 * `data === null` means "loaded, no node yet"; `undefined` means "still loading".
 */
export function useMyNode(): UseQueryResult<UserNodeStatus | null> {
  const { oxyServices } = useOxy();
  const userId = useCurrentUserId();

  return useQuery<UserNodeStatus | null>({
    queryKey: nodeQueryKey(userId),
    queryFn: () => {
      if (!oxyServices) {
        throw new Error('OxyServices not initialized');
      }
      return oxyServices.getMyNode();
    },
    enabled: Boolean(oxyServices) && Boolean(userId),
    staleTime: NODE_STALE_TIME_MS,
    gcTime: NODE_GC_TIME_MS,
  });
}

/**
 *   idle    → awaiting the user's action
 *   working → biometric passed (where gated); the SDK call is in flight
 *   done    → the mutation succeeded
 *   error   → the mutation failed (see `errorCode`)
 */
export type NodeMutationState = 'idle' | 'working' | 'done' | 'error';

export interface UseRegisterNode {
  state: NodeMutationState;
  /** Set when the device biometric/passcode gate was not satisfied. */
  biometricFailed: boolean;
  /** Classified rejection code for the `error` state (drives friendly copy). */
  errorCode: NodeErrorCode | null;
  /** The freshly-materialized node for the `done` state. */
  result: UserNodeStatus | null;
  /** Run the biometric gate, then sign + publish the self-hosted node registration. */
  register: (input: RegisterNodeInput) => Promise<void>;
  /** Reset back to `idle` (e.g. to retry after an error). */
  reset: () => void;
}

/**
 * Register the caller's SELF-HOSTED node (advanced "Connect my own node" flow).
 *
 * Registration signs a `type:'node'` record on the caller's own hash chain with
 * the on-device identity key, so it is gated behind the device biometric BEFORE
 * `registerNode` signs. The server is authoritative — it verifies the signature
 * and rejects a malformed endpoint (no node materializes); those surface as a
 * classified `errorCode`. On success the node query is invalidated so the status
 * view reflects the new node. NATIVE-ONLY (the registration signs on-device).
 *
 * @param biometricReason - Localized prompt shown in the biometric dialog.
 */
export function useRegisterNode(biometricReason: string): UseRegisterNode {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const userId = useCurrentUserId();
  const [state, setState] = useState<NodeMutationState>('idle');
  const [biometricFailed, setBiometricFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<NodeErrorCode | null>(null);
  const [result, setResult] = useState<UserNodeStatus | null>(null);

  const reset = useCallback(() => {
    setState('idle');
    setBiometricFailed(false);
    setErrorCode(null);
    setResult(null);
  }, []);

  const register = useCallback(
    async (input: RegisterNodeInput) => {
      if (!oxyServices) return;

      // Biometric/passcode gate — must pass BEFORE we sign the registration.
      setBiometricFailed(false);
      const auth = await authenticate(biometricReason);
      if (!auth.success) {
        setBiometricFailed(true);
        return;
      }

      setState('working');
      try {
        const node = await oxyServices.registerNode(input);
        setResult(node);
        setState('done');
        void queryClient.invalidateQueries({ queryKey: nodeQueryKey(userId) });
      } catch (error: unknown) {
        setErrorCode(nodeErrorCode(error));
        setState('error');
      }
    },
    [oxyServices, biometricReason, queryClient, userId],
  );

  return { state, biometricFailed, errorCode, result, register, reset };
}

export interface UseProvisionVault {
  state: NodeMutationState;
  biometricFailed: boolean;
  errorCode: NodeErrorCode | null;
  /** The provisioned managed vault for the `done` state. */
  result: UserNodeStatus | null;
  /** Run the biometric gate, then ask Oxy to provision a managed vault. */
  provision: () => Promise<void>;
  reset: () => void;
}

/**
 * Provision an Oxy-operated MANAGED vault (the recommended "Create a managed
 * vault" flow). Oxy custodial-signs the node registration server-side, so no
 * on-device signing happens — but provisioning the source of truth for the
 * caller's identity is an account-level action, so it is biometric-gated for
 * parity with the other node mutations. A 503 (config unavailable) classifies to
 * `managed_unavailable`. On success the node query is invalidated.
 *
 * @param biometricReason - Localized prompt shown in the biometric dialog.
 */
export function useProvisionVault(biometricReason: string): UseProvisionVault {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const userId = useCurrentUserId();
  const [state, setState] = useState<NodeMutationState>('idle');
  const [biometricFailed, setBiometricFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<NodeErrorCode | null>(null);
  const [result, setResult] = useState<UserNodeStatus | null>(null);

  const reset = useCallback(() => {
    setState('idle');
    setBiometricFailed(false);
    setErrorCode(null);
    setResult(null);
  }, []);

  const provision = useCallback(async () => {
    if (!oxyServices) return;

    setBiometricFailed(false);
    const auth = await authenticate(biometricReason);
    if (!auth.success) {
      setBiometricFailed(true);
      return;
    }

    setState('working');
    try {
      const node = await oxyServices.provisionManagedVault();
      setResult(node);
      setState('done');
      void queryClient.invalidateQueries({ queryKey: nodeQueryKey(userId) });
    } catch (error: unknown) {
      setErrorCode(nodeErrorCode(error));
      setState('error');
    }
  }, [oxyServices, biometricReason, queryClient, userId]);

  return { state, biometricFailed, errorCode, result, provision, reset };
}

export interface UseRemoveNode {
  state: NodeMutationState;
  biometricFailed: boolean;
  errorCode: NodeErrorCode | null;
  /** Run the biometric gate, then revoke the caller's node registration. */
  remove: () => Promise<void>;
  reset: () => void;
}

/**
 * Disconnect (revoke) the caller's node (the destructive "Disconnect node"
 * action). Revoking removes the node from the DID document and the liveness
 * sweeps — an account-level change, so it is biometric-gated. On success the node
 * query is invalidated so the status view returns to the "no node" state.
 *
 * @param biometricReason - Localized prompt shown in the biometric dialog.
 */
export function useRemoveNode(biometricReason: string): UseRemoveNode {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const userId = useCurrentUserId();
  const [state, setState] = useState<NodeMutationState>('idle');
  const [biometricFailed, setBiometricFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<NodeErrorCode | null>(null);

  const reset = useCallback(() => {
    setState('idle');
    setBiometricFailed(false);
    setErrorCode(null);
  }, []);

  const remove = useCallback(async () => {
    if (!oxyServices) return;

    setBiometricFailed(false);
    const auth = await authenticate(biometricReason);
    if (!auth.success) {
      setBiometricFailed(true);
      return;
    }

    setState('working');
    try {
      await oxyServices.removeMyNode();
      setState('done');
      void queryClient.invalidateQueries({ queryKey: nodeQueryKey(userId) });
    } catch (error: unknown) {
      setErrorCode(nodeErrorCode(error));
      setState('error');
    }
  }, [oxyServices, biometricReason, queryClient, userId]);

  return { state, biometricFailed, errorCode, remove, reset };
}

export interface UseSyncNode {
  state: NodeMutationState;
  /** Send the ingest hint and refresh the node status. No biometric gate. */
  sync: () => Promise<void>;
  reset: () => void;
}

/**
 * Trigger a node sync ("Sync now"). Sends the unauthenticated `notifyNodeIngest`
 * hint (a fire-and-forget re-pull request the server fully re-verifies, so it can
 * never inject data) and then invalidates the node query so the freshly-probed
 * status loads. No biometric gate — it neither signs nor mutates authoritative
 * state.
 */
export function useSyncNode(): UseSyncNode {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const userId = useCurrentUserId();
  const [state, setState] = useState<NodeMutationState>('idle');

  const reset = useCallback(() => setState('idle'), []);

  const sync = useCallback(async () => {
    if (!oxyServices || !userId) return;
    setState('working');
    try {
      await oxyServices.notifyNodeIngest(userId);
      setState('done');
      void queryClient.invalidateQueries({ queryKey: nodeQueryKey(userId) });
    } catch {
      // The hint is best-effort; a failed notify is non-fatal. Surface a quiet
      // error state so the screen can show a "couldn't sync" note without blocking.
      setState('error');
    }
  }, [oxyServices, userId, queryClient]);

  return { state, sync, reset };
}
