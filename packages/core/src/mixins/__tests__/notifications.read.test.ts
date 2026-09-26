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

describe('OxyServices notification reads', () => {
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
    oxy.setTokens('test-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('getNotifications returns the page the API sends, with the paging it asked for', async () => {
    const page = { notifications: [SYSTEM_NOTIFICATION], unreadCount: 1, hasMore: false, page: 2, limit: 10 };
    answer({ data: page });

    await expect(oxy.getNotifications({ page: 2, limit: 10 })).resolves.toEqual(page);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/notifications');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('getUnreadCount reads `unreadCount`', async () => {
    answer({ data: { unreadCount: 3 } });

    await expect(oxy.getUnreadCount()).resolves.toBe(3);
  });

  it('markNotificationAsRead returns the stored notification', async () => {
    answer({ data: { notification: { ...SYSTEM_NOTIFICATION, read: true } } });

    await expect(oxy.markNotificationAsRead(SYSTEM_NOTIFICATION._id)).resolves.toEqual({
      ...SYSTEM_NOTIFICATION,
      read: true,
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `http://api.test.invalid/notifications/${SYSTEM_NOTIFICATION._id}/read`,
    );
  });
});
