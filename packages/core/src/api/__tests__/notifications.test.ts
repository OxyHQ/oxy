/**
 * The notification READ methods against the wire bodies `GET /notifications`,
 * `GET /notifications/unread-count` and `PUT /notifications/:id/read` actually
 * send (`packages/api/src/controllers/notification.controller.ts`), driven
 * through the real HTTP stack with only `fetch` stubbed.
 *
 * They used to be typed against a shape the API never sent: `getNotifications`
 * claimed an array while the server answers a page object, `getUnreadCount`
 * read `count` from a body that carries `unreadCount` (so it always returned
 * `undefined`), and `markNotificationAsRead` dropped the stored notification the
 * server returns — the one authoritative read of a notification by id.
 */

import { OxyServices } from '../../OxyServices';

const SYSTEM_NOTIFICATION = {
  _id: '0192f0c4-7b1e-7000-8000-000000000001',
  recipientId: 'user-1',
  actorId: 'user-1',
  type: 'system',
  entityId: 'job-42',
  entityType: 'app',
  title: 'Your Mastodon account moved',
  message: '312 followers came with you.',
  url: 'https://move.oxy.so/jobs/job-42',
  read: false,
  createdAt: '2026-09-26T10:00:00.000Z',
  updatedAt: '2026-09-26T10:00:00.000Z',
};

describe('oxy.notifications reads', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  function answer(body: unknown): void {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  }

  let oxy: OxyServices;
  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    oxy = new OxyServices({ baseURL: 'http://api.test.invalid' });
    oxy.session.setAccessToken('test-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('list returns the page the API sends, with the paging it asked for', async () => {
    const page = { notifications: [SYSTEM_NOTIFICATION], unreadCount: 1, hasMore: false, page: 2, limit: 10 };
    answer({ data: page });

    await expect(oxy.notifications.list({ page: 2, limit: 10 })).resolves.toEqual(page);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/notifications');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('unreadCount reads `unreadCount`', async () => {
    answer({ data: { unreadCount: 3 } });

    await expect(oxy.notifications.unreadCount()).resolves.toBe(3);
  });

  it('markRead returns the stored notification', async () => {
    answer({ data: { notification: { ...SYSTEM_NOTIFICATION, read: true } } });

    await expect(oxy.notifications.markRead(SYSTEM_NOTIFICATION._id)).resolves.toEqual({
      ...SYSTEM_NOTIFICATION,
      read: true,
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `http://api.test.invalid/notifications/${SYSTEM_NOTIFICATION._id}/read`,
    );
  });
});

describe('oxy.notifications writes and push tokens', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  let oxy: OxyServices;

  beforeEach(() => {
    fetchMock = jest.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    oxy = new OxyServices({ baseURL: 'http://api.test.invalid' });
    oxy.session.setAccessToken('test-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const call = (i = 0): { url: string; method?: string; body?: unknown } => {
    const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
    return { url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
  };

  it('markAllRead PUTs /notifications/read-all', async () => {
    await oxy.notifications.markAllRead();
    expect(call()).toMatchObject({ url: 'http://api.test.invalid/notifications/read-all', method: 'PUT' });
  });

  it('delete encodes the id', async () => {
    await oxy.notifications.delete('a/b');
    expect(call()).toMatchObject({ url: 'http://api.test.invalid/notifications/a%2Fb', method: 'DELETE' });
  });

  it('registerPushToken sends the Expo token and omits absent optionals', async () => {
    await oxy.notifications.registerPushToken({ expoPushToken: 'ExponentPushToken[abc]', platform: 'ios' });
    expect(call()).toEqual({
      url: 'http://api.test.invalid/notifications/push-token',
      method: 'POST',
      body: { token: 'ExponentPushToken[abc]', platform: 'ios' },
    });
  });

  it('registerPushToken rejects a raw APNs/FCM token before any request', async () => {
    await expect(
      oxy.notifications.registerPushToken({ expoPushToken: 'a1b2c3d4e5', platform: 'android' }),
    ).rejects.toThrow(/Expo push token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unregisterPushToken DELETEs with the token in the body', async () => {
    await oxy.notifications.unregisterPushToken('ExponentPushToken[abc]');
    expect(call()).toEqual({
      url: 'http://api.test.invalid/notifications/push-token',
      method: 'DELETE',
      body: { token: 'ExponentPushToken[abc]' },
    });
  });
});
