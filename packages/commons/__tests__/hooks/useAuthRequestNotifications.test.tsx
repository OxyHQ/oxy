import { act, renderHook, waitFor } from '@testing-library/react';
import { __getMockRouter } from '@/__mocks__/expo-router';
import {
  __emitNotificationResponse,
  __hasNotificationResponseListener,
  __notificationUnsubscribe,
  __resetNotificationAdapter,
  subscribeToNotificationResponses,
  takeLaunchNotificationData,
} from '@/__mocks__/oxyhq-services';
import { COMMONS_AUTH_REQUEST_PUSH_TYPE } from '@/lib/notifications/auth-request-push';
import {
  coldLaunchApprovalCode,
  useAuthRequestNotifications,
} from '@/hooks/notifications/useAuthRequestNotifications';

const router = __getMockRouter();

function pushPayload(approvalUrl: string): Record<string, unknown> {
  return { type: COMMONS_AUTH_REQUEST_PUSH_TYPE, approvalUrl };
}

/**
 * Tapping an auth-request push may do EXACTLY ONE thing: open the existing
 * approval route with the authorize code. It must never approve, and it must
 * never carry anything from the (untrusted) payload into the app.
 *
 * NOTE: the module-level claim ledger is per app session, so each test uses its
 * own authorize code — the same way two real notifications carry two codes.
 *
 * The subscription itself is the shared `@oxyhq/services` adapter (stubbed here,
 * tested in that package); what is asserted below is Commons' handling of what
 * the adapter delivers.
 */
describe('useAuthRequestNotifications', () => {
  beforeEach(() => {
    router.push.mockClear();
    router.replace.mockClear();
    __resetNotificationAdapter();
  });

  it('does not listen while the router gate is unresolved', async () => {
    renderHook(() => useAuthRequestNotifications(false));

    await act(async () => {
      await Promise.resolve();
    });
    expect(subscribeToNotificationResponses).not.toHaveBeenCalled();
  });

  it('opens the approval route with ONLY the authorize code', async () => {
    renderHook(() => useAuthRequestNotifications(true));
    await waitFor(() => expect(__hasNotificationResponseListener()).toBe(true));

    act(() => {
      __emitNotificationResponse({
        ...pushPayload('oxycommons://approve?v=1&code=warm-1&app=Evil%20Bank'),
        appName: 'Evil Bank',
        body: 'Approve now',
      });
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    const [target] = router.push.mock.calls[0] as [{ pathname: string; params: Record<string, string> }];
    expect(target.pathname).toBe('/approve');
    expect(target.params).toEqual({ code: 'warm-1' });
    // Nothing from the payload rides along — not the app name, not the origin.
    expect(Object.keys(target.params)).toEqual(['code']);
  });

  it.each([
    ['a foreign scheme', 'evil://approve?code=drop-1'],
    ['a missing code', 'oxycommons://approve?v=1'],
    ['a non-approval route', 'oxycommons://attest?subject=did:web:oxy.so:u:1'],
  ])('drops %s and navigates nowhere', async (_label, approvalUrl) => {
    renderHook(() => useAuthRequestNotifications(true));
    await waitFor(() => expect(__hasNotificationResponseListener()).toBe(true));

    act(() => {
      __emitNotificationResponse(pushPayload(approvalUrl));
    });

    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('drops a push that is not a Commons auth request', async () => {
    renderHook(() => useAuthRequestNotifications(true));
    await waitFor(() => expect(__hasNotificationResponseListener()).toBe(true));

    act(() => {
      __emitNotificationResponse({
        type: 'marketing',
        approvalUrl: 'oxycommons://approve?code=drop-2',
      });
      __emitNotificationResponse(null);
      __emitNotificationResponse('oxycommons://approve?code=drop-3');
    });

    expect(router.push).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useAuthRequestNotifications(true));
    await waitFor(() => expect(__hasNotificationResponseListener()).toBe(true));

    unmount();

    expect(__notificationUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('coldLaunchApprovalCode', () => {
  beforeEach(() => {
    __resetNotificationAdapter();
  });

  it('resolves the code carried by the launching notification', async () => {
    takeLaunchNotificationData.mockResolvedValue(
      pushPayload('oxycommons://approve?v=1&code=cold-1'),
    );

    await expect(coldLaunchApprovalCode()).resolves.toBe('cold-1');
  });

  it('claims the code so the warm listener cannot route the same tap twice', async () => {
    takeLaunchNotificationData.mockResolvedValue(pushPayload('oxycommons://approve?code=cold-2'));

    await expect(coldLaunchApprovalCode()).resolves.toBe('cold-2');
    // A second reader of the SAME launching tap gets nothing.
    await expect(coldLaunchApprovalCode()).resolves.toBeNull();
  });

  it('resolves null when nothing launched the app', async () => {
    await expect(coldLaunchApprovalCode()).resolves.toBeNull();
  });

  it('resolves null for an unparseable launching payload', async () => {
    takeLaunchNotificationData.mockResolvedValue(pushPayload('evil://approve?code=cold-3'));

    await expect(coldLaunchApprovalCode()).resolves.toBeNull();
  });
});
