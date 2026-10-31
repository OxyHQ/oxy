import { MutationCache, type Mutation } from '@tanstack/react-query';

/**
 * A strict prototype client quarantines every TanStack mutation. Registered
 * operations run separately through the explicit owner-bound registry. This is
 * deliberately incompatible with ordinary useMutation until those callers are
 * migrated; records are retained and no automatic replay occurs.
 */
export class ExperimentalQuarantinedMutationCache extends MutationCache {
  override add(mutation: Mutation): void {
    if (mutation.state.status === 'idle')
      throw new Error('Unregistered mutations are unavailable in strict mode');
    super.add(mutation);
  }
  override canRun(_mutation: Mutation): boolean {
    return false;
  }
  override resumePausedMutations(): Promise<unknown> {
    return Promise.resolve();
  }
  override runNext(_mutation: Mutation): Promise<unknown> {
    return Promise.resolve();
  }
}
