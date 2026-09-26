import { act, renderHook, waitFor } from '@testing-library/react';
import { Linking } from 'react-native';
import { OXY_SYSTEM_NOTIFICATION_PUSH_TYPE } from '@oxy.so/contracts';
import type { Notification } from '@oxy.so/core';
import {
  __emitNotificationResponse,
  __hasNotificationResponseListener,
  __resetNotificationAdapter,
  __resetOxyState,
  __setOxyState,
  subscribeToNotificationResponses,
} from '@/__mocks__/oxy-services';
import {
  openSystemNotification,
  systemNotificationIdFromPush,
} from '@/lib/notifications/system-notification-push';
import { useSystemNotificationTaps } from '@/hooks/notifications/useSystemNotificationTaps';

/**
 * A tapped `system` notification push (Oxy Move's "your Mastodon account
 * moved") opens the link OXY stored for that notification — never anything
 * from the untrusted payload — and marks it read.
 *
 * Each test uses its own notification id: the claim ledger is per app session,
 * the same way two real notifications carry two ids.
 */

function stored(overrides: Partial<Notification> = {}): Notification {
  return {
    _id: 'n-1',
    recipientId: 'user-1',
    actorId: 'user-1',
    type: 'system',
    entityId: 'job-42',
    entityType: 'app',
    title: 'Your Mastodon account moved',
    message: '312 followers came with you.',
    url: 'https://move.oxy.so/jobs/job-42',
    read: true,
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    ...overrides,
  };
}

function push(notificationId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: OXY_SYSTEM_NOTIFICATION_PUSH_TYPE, notificationId, ...extra };
}

describe('systemNotificationIdFromPush', () => {
  it('reads the id of a system-notification push, and nothing else', () => {
    expect(systemNotificationIdFromPush(push('n-7'))).toBe('n-7');
    expect(systemNotificationIdFromPush({ type: 'oxy_commons_auth_request', notificationId: 'n-7' })).toBeNull();
    expect(systemNotificationIdFromPush({ type: OXY_SYSTEM_NOTIFICATION_PUSH_TYPE })).toBeNull();
    expect(systemNotificationIdFromPush(null)).toBeNull();
  });
});

describe('openSystemNotification', () => {
  it('marks the notification read and opens the url Oxy stored for it', async () => {
    const reader = { notifications: { markRead: jest.fn(async () => stored()) } };
    const openUrl = jest.fn(async () => undefined);

    await expect(openSystemNotification(reader, 'n-1', openUrl)).resolves.toBe('opened');

    expect(reader.notifications.markRead).toHaveBeenCalledWith('n-1');
    expect(openUrl).toHaveBeenCalledWith('https://move.oxy.so/jobs/job-42');
  });

  it.each([
    ['no url', stored({ url: undefined })],
    ['a non-system notification', stored({ type: 'follow', url: undefined })],
    ['an http url', stored({ url: 'http://move.oxy.so/jobs/1' })],
    ['a javascript url', stored({ url: 'javascript:alert(1)' })],
  ])('opens nothing for %s', async (_label, notification) => {
    const openUrl = jest.fn(async () => undefined);

    await expect(
      openSystemNotification({ notifications: { markRead: async () => notification } }, 'n-1', openUrl),
    ).resolves.toBe('no-link');
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('useSystemNotificationTaps', () => {
  let openURL: jest.SpyInstance;
  let markNotificationAsRead: jest.Mock;

  beforeEach(() => {
    __resetNotificationAdapter();
    __resetOxyState();
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    markNotificationAsRead = jest.fn(async (id: string) => stored({ _id: id }));
    __setOxyState({
      canUsePrivateApi: true,
      oxyServices: { updateProfile: jest.fn(), markNotificationAsRead } as never,
    });
  });

  afterEach(() => {
    openURL.mockRestore();
  });

  it('opens the stored link of a tapped push — not a link the payload carries', async () => {
    renderHook(() => useSystemNotificationTaps(true, null));
    await waitFor(() => expect(__hasNotificationResponseListener()).toBe(true));

    act(() => {
      __emitNotificationResponse(push('warm-1', { url: 'https://evil.example/phish' }));
    });

    await waitFor(() => expect(openURL).toHaveBeenCalledWith('https://move.oxy.so/jobs/job-42'));
    expect(markNotificationAsRead).toHaveBeenCalledWith('warm-1');
    expect(openURL).not.toHaveBeenCalledWith('https://evil.example/phish');
  });

  it('opens the notification that cold-launched the app, once', async () => {
    renderHook(() => useSystemNotificationTaps(true, 'cold-1'));
    await waitFor(() => expect(openURL).toHaveBeenCalledTimes(1));

    // The OS replaying the same launching tap to the listener is a no-op.
    act(() => {
      __emitNotificationResponse(push('cold-1'));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(markNotificationAsRead).toHaveBeenCalledTimes(1);
  });

  it('waits for the routing gate and a usable session', async () => {
    __setOxyState({ canUsePrivateApi: false });
    const { rerender } = renderHook(({ enabled }) => useSystemNotificationTaps(enabled, 'gated-1'), {
      initialProps: { enabled: false },
    });
    rerender({ enabled: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(subscribeToNotificationResponses).not.toHaveBeenCalled();
    expect(markNotificationAsRead).not.toHaveBeenCalled();

    act(() => {
      __setOxyState({ canUsePrivateApi: true });
    });
    await waitFor(() => expect(markNotificationAsRead).toHaveBeenCalledWith('gated-1'));
  });

  it('ignores a push that is not a system notification', async () => {
    renderHook(() => useSystemNotificationTaps(true, null));
    await waitFor(() => expect(__hasNotificationResponseListener()).toBe(true));

    act(() => {
      __emitNotificationResponse({ type: 'oxy_commons_auth_request', approvalUrl: 'oxycommons://approve?code=x' });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(markNotificationAsRead).not.toHaveBeenCalled();
  });
});
