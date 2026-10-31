import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { ExperimentalMutationOwner } from './experimentalOwnedMutationCache';

interface Gate {
  lease(): number;
  isCurrent(lease: number): boolean;
  snapshot(): { actorId: string; accountId: string; sessionId: string } | null;
  subscribe(listener: () => void): () => void;
}

/**
 * Cooperative read facade for one staged owner. The caller must not expose the
 * underlying QueryClient or Query objects. Values returned before invalidation
 * cannot be revoked, and arbitrary code holding the raw client is outside it.
 */
export function createExperimentalScopedQueryView(
  client: QueryClient,
  gate: Gate,
  expected: ExperimentalMutationOwner,
) {
  const snapshot = gate.snapshot();
  if (
    !snapshot ||
    snapshot.actorId !== expected.actorId ||
    snapshot.accountId !== expected.accountId ||
    snapshot.sessionId !== expected.sessionId
  )
    throw new Error('Context binding unavailable');
  const lease = gate.lease();
  if (!gate.isCurrent(lease) || gate.snapshot() !== snapshot)
    throw new Error('Context binding unavailable');

  return Object.freeze({
    read<T>(key: QueryKey): T | undefined {
      if (!gate.isCurrent(lease)) return undefined;
      const data = client.getQueryData<T>(key);
      return gate.isCurrent(lease) ? data : undefined;
    },
    subscribe(listener: () => void): () => void {
      let unavailableNotified = false;
      const onChange = () => {
        if (!gate.isCurrent(lease)) {
          if (unavailableNotified) return;
          unavailableNotified = true;
        }
        listener();
      };
      const unsubscribeCache = client.getQueryCache().subscribe(onChange);
      const unsubscribeGate = gate.subscribe(onChange);
      return () => {
        unsubscribeCache();
        unsubscribeGate();
      };
    },
    /** Gate deferred navigation or another synchronous owner-scoped action. */
    runIfCurrent(action: () => void): boolean {
      if (!gate.isCurrent(lease)) return false;
      action();
      return gate.isCurrent(lease);
    },
  });
}

/**
 * The owner-specific client is staged while closed and only its facade is
 * published after the gate verifies the same owner. The staging owner is a
 * trusted integration seam, not an authorization mechanism.
 */
export function createExperimentalStagedQueryPublisher(gate: Gate) {
  let staged: { owner: ExperimentalMutationOwner; client: QueryClient } | null = null;
  return {
    stage(owner: ExperimentalMutationOwner, client: QueryClient): void {
      if (gate.snapshot()) throw new Error('Context gate must be closed for staging');
      staged = { owner: { ...owner }, client };
    },
    publish() {
      if (!staged) throw new Error('No staged query client');
      return createExperimentalScopedQueryView(staged.client, gate, staged.owner);
    },
  };
}
