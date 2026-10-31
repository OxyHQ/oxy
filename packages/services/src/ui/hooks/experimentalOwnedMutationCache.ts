import { MutationCache, type Mutation } from '@tanstack/react-query';

/** Experimental owner identity; a bearer or credential must never be stored here. */
export interface ExperimentalMutationOwner {
  actorId: string;
  accountId: string;
  sessionId: string;
}

function sameOwner(
  a: ExperimentalMutationOwner | undefined,
  b: ExperimentalMutationOwner | null,
): boolean {
  return (
    !!a &&
    !!b &&
    a.actorId === b.actorId &&
    a.accountId === b.accountId &&
    a.sessionId === b.sessionId
  );
}

/**
 * Prototype for an opt-in QueryClient only. Mutations of unknown provenance stay
 * quarantined. The caller must verify the owner of a restored blob before binding
 * it; account-only legacy blobs are not evidence of an actor or session.
 */
export class ExperimentalOwnedMutationCache extends MutationCache {
  private readonly owners = new WeakMap<Mutation, ExperimentalMutationOwner>();

  constructor(private readonly currentOwner: () => ExperimentalMutationOwner | null) {
    super();
  }

  override add(mutation: Mutation): void {
    // Hydrated pending work must be bound only after its enclosing blob has
    // been verified. Newly-created idle work captures the current owner.
    const owner = mutation.state.status === 'idle' ? this.currentOwner() : null;
    if (owner) this.owners.set(mutation, { ...owner });
    super.add(mutation);
  }

  bindVerifiedRestored(mutation: Mutation, owner: ExperimentalMutationOwner): void {
    if (mutation.state.status !== 'pending' || !this.getAll().includes(mutation))
      throw new Error('Only restored pending mutations may be bound');
    if (this.owners.has(mutation)) throw new Error('Mutation owner is already bound');
    this.owners.set(mutation, { ...owner });
  }

  override canRun(mutation: Mutation): boolean {
    const current = this.currentOwner();
    if (!sameOwner(this.owners.get(mutation), current)) return false;
    const scope = mutation.options.scope?.id;
    if (!scope) return true;
    const first = this.getAll().find(
      (candidate) =>
        candidate.state.status === 'pending' &&
        candidate.options.scope?.id === scope &&
        sameOwner(this.owners.get(candidate), current),
    );
    return !first || first === mutation;
  }

  override resumePausedMutations(): Promise<unknown> {
    return Promise.all(
      this.getAll()
        .filter((mutation) => mutation.state.isPaused && this.canRun(mutation))
        .map((mutation) => mutation.continue().catch(() => undefined)),
    );
  }

  override runNext(mutation: Mutation): Promise<unknown> {
    const scope = mutation.options.scope?.id;
    if (!scope) return Promise.resolve();
    const next = this.getAll().find(
      (candidate) =>
        candidate !== mutation &&
        candidate.state.isPaused &&
        candidate.options.scope?.id === scope &&
        this.canRun(candidate),
    );
    return next?.continue() ?? Promise.resolve();
  }
}

/** Actor- and session-bound storage key; never reads or rewrites an old account-only blob. */
export function experimentalOwnerStorageKey(owner: ExperimentalMutationOwner): string {
  return `oxy_context_queries:v1:${encodeURIComponent(JSON.stringify([owner.actorId, owner.accountId, owner.sessionId]))}`;
}

/**
 * Experimental last-moment executor fence. The owner notification must fire
 * when the barrier opens or closes. A waiter is pending but TanStack may report
 * `isPaused: false`; a strict persister must explicitly persist that waiter.
 */
export function experimentalGuardMutationExecution<TVariables, TResult>(
  owner: ExperimentalMutationOwner,
  currentOwner: () => ExperimentalMutationOwner | null,
  subscribe: (listener: () => void) => () => void,
  execute: (variables: TVariables) => Promise<TResult>,
): { run: (variables: TVariables) => Promise<TResult>; isWaiting: () => boolean } {
  let waiters = 0;
  return {
    isWaiting: () => waiters > 0,
    run: (variables) =>
      new Promise<TResult>((resolve, reject) => {
        let done = false;
        let unsubscribe = () => {};
        const attempt = () => {
          if (done || !sameOwner(owner, currentOwner())) return;
          done = true;
          waiters -= 1;
          unsubscribe();
          try {
            void execute(variables).then(resolve, reject);
          } catch (error) {
            reject(error);
          }
        };
        waiters += 1;
        try {
          unsubscribe = subscribe(attempt);
        } catch (error) {
          waiters -= 1;
          reject(error);
          return;
        }
        if (done) unsubscribe();
        else attempt();
      }),
  };
}
