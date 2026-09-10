import { act, renderHook, waitFor } from '@testing-library/react';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';
import type { LocalConfirmationResult } from '@/lib/biometricAuth';

const requestLocalConfirmationMock = jest.fn<Promise<LocalConfirmationResult>, [string]>();

// Replace the local-confirmation helper entirely so the test controls the gate
// outcome and never loads `expo-local-authentication`.
jest.mock('@/lib/biometricAuth', () => ({
  requestLocalConfirmation: (reason: string) => requestLocalConfirmationMock(reason),
}));

// Imported AFTER jest.mock so the hook sees the patched biometric helper.
// eslint-disable-next-line import/first
import { useCommonsApproval } from '@/hooks/commons-signin/useCommonsApproval';

const SAMPLE_INFO = {
  application: {
    id: 'app1',
    name: 'Mention',
    type: 'first_party',
    isOfficial: true,
    isInternal: false,
    scopes: ['profile:read'],
    developerName: 'Oxy',
  },
  scopes: ['profile:read', 'email:read'],
  boundOrigin: 'https://mention.earth',
  originVerified: true,
  requesterLabel: 'Chrome on Windows',
  purpose: 'device_sign_in',
  subjectAccount: null,
  expiresAt: Date.now() + 300_000,
  status: 'pending',
};

interface ServiceOverrides {
  getCommonsApprovalInfo?: jest.Mock;
  markCommonsApprovalOpened?: jest.Mock;
  approveCommonsSignIn?: jest.Mock;
  denyCommonsSignIn?: jest.Mock;
}

function installServices(overrides: ServiceOverrides = {}) {
  const services = {
    getCommonsApprovalInfo: jest.fn(async () => SAMPLE_INFO),
    markCommonsApprovalOpened: jest.fn(async () => undefined),
    approveCommonsSignIn: jest.fn(async () => ({ success: true })),
    denyCommonsSignIn: jest.fn(async () => ({ success: true })),
    ...overrides,
  };
  __setOxyState({
    isAuthenticated: true,
    user: { username: 'nate' },
    oxyServices: services,
  });
  return services;
}

describe('useCommonsApproval', () => {
  beforeEach(() => {
    __resetOxyState();
    requestLocalConfirmationMock.mockReset();
    requestLocalConfirmationMock.mockResolvedValue({ outcome: 'confirmed' });
  });

  it('resolves the server-side application identity on mount', async () => {
    const services = installServices();
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));

    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(services.getCommonsApprovalInfo).toHaveBeenCalledWith('code-1');
    expect(result.current.info?.application?.name).toBe('Mention');
    expect(result.current.info?.application?.isOfficial).toBe(true);
    // The coarse client label is surfaced exactly as the server sent it.
    expect(result.current.info?.requesterLabel).toBe('Chrome on Windows');
  });

  it('surfaces the delegated subject account exactly as the server resolved it', async () => {
    installServices({
      getCommonsApprovalInfo: jest.fn(async () => ({
        ...SAMPLE_INFO,
        purpose: 'oauth_authorization',
        subjectAccount: { id: 'acct-9', username: 'oxycollective', displayName: 'The Oxy Collective' },
      })),
    });
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));

    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.info?.subjectAccount).toEqual({
      id: 'acct-9',
      username: 'oxycollective',
      displayName: 'The Oxy Collective',
    });
  });

  it('enters the error state when the code cannot be resolved', async () => {
    installServices({
      getCommonsApprovalInfo: jest.fn(async () => {
        throw new Error('used');
      }),
    });
    const { result } = renderHook(() => useCommonsApproval('bad', 'reason'));

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorMessage).toBe('used');
  });

  it('errors immediately when no code is supplied', async () => {
    installServices();
    const { result } = renderHook(() => useCommonsApproval(undefined, 'reason'));

    await waitFor(() => expect(result.current.state).toBe('error'));
  });

  it('opens the device confirmation DIRECTLY from the single primary action', async () => {
    const services = installServices();
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    await act(async () => {
      await result.current.approve();
    });

    // One call to `approve()` prompted the device and completed the approval —
    // there is no intermediate step to pass through first.
    expect(requestLocalConfirmationMock).toHaveBeenCalledTimes(1);
    expect(requestLocalConfirmationMock).toHaveBeenCalledWith('reason');
    expect(services.approveCommonsSignIn).toHaveBeenCalledWith({ authorizeCode: 'code-1' });
    expect(result.current.state).toBe('approved');
  });

  it('signs only AFTER the confirmation resolves', async () => {
    const services = installServices();
    let confirm: ((result: LocalConfirmationResult) => void) | null = null;
    requestLocalConfirmationMock.mockImplementation(
      () =>
        new Promise<LocalConfirmationResult>((resolve) => {
          confirm = resolve;
        }),
    );
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    act(() => {
      void result.current.approve();
    });

    await waitFor(() => expect(result.current.state).toBe('confirming'));
    expect(services.approveCommonsSignIn).not.toHaveBeenCalled();

    await act(async () => {
      confirm?.({ outcome: 'confirmed' });
    });

    await waitFor(() => expect(result.current.state).toBe('approved'));
    expect(services.approveCommonsSignIn).toHaveBeenCalledTimes(1);
  });

  it('never approves on a device with no enrolled biometrics — and says why', async () => {
    const services = installServices();
    requestLocalConfirmationMock.mockResolvedValue({
      outcome: 'unavailable',
      reason: 'no_enrollment',
    });
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    await act(async () => {
      await result.current.approve();
    });

    expect(services.approveCommonsSignIn).not.toHaveBeenCalled();
    expect(services.denyCommonsSignIn).not.toHaveBeenCalled();
    expect(result.current.confirmationIssue).toEqual({
      kind: 'unavailable',
      reason: 'no_enrollment',
    });
    // The request is left pending and retryable, not silently approved.
    expect(result.current.state).toBe('ready');
  });

  it('reports a device with no biometric hardware distinctly', async () => {
    const services = installServices();
    requestLocalConfirmationMock.mockResolvedValue({
      outcome: 'unavailable',
      reason: 'no_hardware',
    });
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.confirmationIssue).toEqual({
      kind: 'unavailable',
      reason: 'no_hardware',
    });
    expect(services.approveCommonsSignIn).not.toHaveBeenCalled();
  });

  it('distinguishes a cancelled prompt from a failed one and from a lockout', async () => {
    const services = installServices();
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    requestLocalConfirmationMock.mockResolvedValue({ outcome: 'declined' });
    await act(async () => {
      await result.current.approve();
    });
    expect(result.current.confirmationIssue).toEqual({ kind: 'declined' });

    requestLocalConfirmationMock.mockResolvedValue({ outcome: 'lockout' });
    await act(async () => {
      await result.current.approve();
    });
    expect(result.current.confirmationIssue).toEqual({ kind: 'lockout' });

    requestLocalConfirmationMock.mockResolvedValue({ outcome: 'failed' });
    await act(async () => {
      await result.current.approve();
    });
    expect(result.current.confirmationIssue).toEqual({ kind: 'failed' });

    expect(services.approveCommonsSignIn).not.toHaveBeenCalled();
    expect(result.current.state).toBe('ready');
  });

  it('clears a previous confirmation issue when the user retries successfully', async () => {
    const services = installServices();
    requestLocalConfirmationMock.mockResolvedValue({ outcome: 'declined' });
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    await act(async () => {
      await result.current.approve();
    });
    expect(result.current.confirmationIssue).toEqual({ kind: 'declined' });

    requestLocalConfirmationMock.mockResolvedValue({ outcome: 'confirmed' });
    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.confirmationIssue).toBeNull();
    expect(services.approveCommonsSignIn).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('approved');
  });

  it('approves once even when the primary action is double-tapped', async () => {
    const services = installServices();
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    await act(async () => {
      await Promise.all([result.current.approve(), result.current.approve()]);
    });

    expect(requestLocalConfirmationMock).toHaveBeenCalledTimes(1);
    expect(services.approveCommonsSignIn).toHaveBeenCalledTimes(1);
  });

  it('reports "This wasn\'t me" to the server as a not_me denial', async () => {
    const services = installServices();
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    await act(async () => {
      await result.current.deny('not_me');
    });

    expect(services.denyCommonsSignIn).toHaveBeenCalledWith('code-1', 'not_me');
    expect(result.current.state).toBe('denied');
    // Recorded, so the terminal state can say what actually happened.
    expect(result.current.denialReason).toBe('not_me');
    // Denying never asks the device to confirm — it is not an authorization.
    expect(requestLocalConfirmationMock).not.toHaveBeenCalled();
  });

  it('labels an unspecified rejection as an ordinary decline, never as not_me', async () => {
    // `not_me` records the denial as suspicious, so it is opt-in: a caller that
    // does not say the user reported the request gets the neutral value.
    const services = installServices();
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    await act(async () => {
      await result.current.deny();
    });

    expect(services.denyCommonsSignIn).toHaveBeenCalledWith('code-1', 'declined');
    expect(result.current.denialReason).toBe('declined');
  });

  it('records no denial reason until a denial actually completes', async () => {
    installServices({
      denyCommonsSignIn: jest.fn(async () => {
        throw new Error('already authorized');
      }),
    });
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    expect(result.current.denialReason).toBeNull();

    await act(async () => {
      await result.current.deny('not_me');
    });

    // The server refused the denial, so nothing was recorded to describe.
    expect(result.current.state).toBe('error');
    expect(result.current.denialReason).toBeNull();
  });

  it('never denies as a side effect of anything else', async () => {
    const services = installServices();
    const { result, unmount } = renderHook(() => useCommonsApproval('code-1', 'reason'));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    await act(async () => {
      await result.current.approve();
    });
    unmount();

    // Only the explicit `deny()` call denies: not approving, not unmounting
    // (the screen's dismissal path), not the progress signal.
    expect(services.denyCommonsSignIn).not.toHaveBeenCalled();
  });

  it('enters the error state when the application cannot be resolved', async () => {
    installServices({
      getCommonsApprovalInfo: jest.fn(async () => ({
        ...SAMPLE_INFO,
        application: null,
      })),
    });
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorMessage).toMatch(/could not be resolved/i);
  });

  it('reports the approval screen as OPENED so the waiting desktop can show progress', async () => {
    const services = installServices();
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));

    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(services.markCommonsApprovalOpened).toHaveBeenCalledWith('code-1');
  });

  it('does not report progress when there is no code to report', async () => {
    const services = installServices();
    renderHook(() => useCommonsApproval(undefined, 'reason'));

    await waitFor(() => expect(services.getCommonsApprovalInfo).not.toHaveBeenCalled());
    expect(services.markCommonsApprovalOpened).not.toHaveBeenCalled();
  });

  it('approves normally even when the progress signal fails', async () => {
    // The progress line is best-effort: losing it must never cost the user the
    // approval itself.
    const services = installServices({
      markCommonsApprovalOpened: jest.fn(async () => {
        throw new Error('progress endpoint down');
      }),
    });
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));

    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.errorMessage).toBeNull();

    await act(async () => {
      await result.current.approve();
    });

    expect(services.approveCommonsSignIn).toHaveBeenCalledWith({ authorizeCode: 'code-1' });
    expect(result.current.state).toBe('approved');
  });

  it('enters the error state when the session is no longer pending', async () => {
    installServices({
      getCommonsApprovalInfo: jest.fn(async () => ({
        ...SAMPLE_INFO,
        status: 'expired',
      })),
    });
    const { result } = renderHook(() => useCommonsApproval('code-1', 'reason'));

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorMessage).toMatch(/invalid, already used, or expired/i);
  });
});
