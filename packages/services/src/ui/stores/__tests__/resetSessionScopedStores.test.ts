import { useFollowStore } from '../followStore';
import { UNKNOWN_FOLLOW_STATUS, useFollowTargetStore } from '../followTargetStore';
import { resetSessionScopedStores } from '../resetSessionScopedStores';

describe('resetSessionScopedStores', () => {
  beforeEach(() => {
    useFollowStore.getState().resetFollowState();
    useFollowTargetStore.getState().reset();
  });

  it('clears legacy follow state and the v2 follow-target cache', () => {
    useFollowStore.getState().setFollowingStatus('user-1', true);
    useFollowTargetStore.getState().setStatus('target-1', {
      ...UNKNOWN_FOLLOW_STATUS,
      effectiveState: 'following',
    });

    resetSessionScopedStores();

    expect(useFollowStore.getState().followingUsers['user-1']).toBeUndefined();
    expect(useFollowTargetStore.getState().statuses['target-1']).toBeUndefined();
  });
});
