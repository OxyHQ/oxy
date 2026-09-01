import { act, renderHook } from '@testing-library/react';
import type { FollowStatus } from '@oxyhq/contracts';
import { useFollowTarget } from '../../src/ui/hooks/useFollowTarget';
import { useFollowTargetStore } from '../../src/ui/stores/followTargetStore';

const restoreFollowInheritance = jest.fn().mockResolvedValue({ ok: true });
const setFollowApplicationMode = jest.fn().mockResolvedValue({ ok: true, mode: 'disabled' });

jest.mock('../../src/ui/context/OxyContext', () => ({
  useOxy: () => ({
    canUsePrivateApi: true,
    oxyServices: {
      getFollowTargetStatus: jest.fn(),
      restoreFollowInheritance,
      setFollowApplicationMode,
    },
  }),
}));

const activeDisabledHere: FollowStatus = {
  relationshipId: 'rel-1',
  globalState: 'active',
  applicationMode: 'disabled',
  effectiveState: 'not_following',
};

describe('useFollowTarget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useFollowTargetStore.getState().reset();
    useFollowTargetStore.getState().setStatus('target-1', activeDisabledHere);
  });

  it('enableHere restores inheritance instead of pinning enabled', async () => {
    const { result } = renderHook(() => useFollowTarget('target-1'));

    await act(async () => {
      await result.current.enableHere();
    });

    expect(restoreFollowInheritance).toHaveBeenCalledWith('rel-1');
    expect(setFollowApplicationMode).not.toHaveBeenCalled();
    expect(result.current.status.applicationMode).toBe('inherit');
    expect(result.current.status.effectiveState).toBe('following');
  });

  it('disableHere still writes a disabled override', async () => {
    useFollowTargetStore.getState().setStatus('target-1', {
      ...activeDisabledHere,
      applicationMode: 'inherit',
      effectiveState: 'following',
    });

    const { result } = renderHook(() => useFollowTarget('target-1'));

    await act(async () => {
      await result.current.disableHere();
    });

    expect(setFollowApplicationMode).toHaveBeenCalledWith('rel-1', 'disabled');
    expect(restoreFollowInheritance).not.toHaveBeenCalled();
    expect(result.current.status.applicationMode).toBe('disabled');
  });
});
