import { useFollowStore } from './followStore';
import { useFollowTargetStore } from './followTargetStore';

/**
 * Drop session-scoped Zustand slices so the next user/account never inherits
 * stale UI state.
 *
 * The file library is NOT reset here: it lives in React Query keyed by owner id
 * (`queryKeys.files.list(ownerId)`), so switching accounts naturally shows the
 * new owner's files and the old owner's cache is garbage-collected on its own.
 */
export function resetSessionScopedStores(): void {
  useFollowStore.getState().resetFollowState();
  useFollowTargetStore.getState().reset();
}
