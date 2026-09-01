/**
 * Push service, against a REAL Postgres registry with only `fetch` stubbed.
 *
 * Three things are pinned here:
 *
 *  1. **The email notification is byte-for-byte what it always was.** The
 *     hardcoded `channelId: 'email'` became a caller-supplied channel; the wire
 *     payload for the email caller must not have moved a single byte. The
 *     expected request body below is an exact string, not a shape.
 *  2. **The channel is caller-supplied and never defaulted**, and the explicit
 *     token-targeting entry point delivers to exactly the tokens it is given
 *     (used by identity-approval delivery, where the CALLER owns the targeting).
 *  3. **`DeviceNotRegistered` pruning really removes the row, and only that
 *     row.** The previous version asserted that `PushToken.deleteOne` had been
 *     CALLED with a particular filter object — which is a claim about a query,
 *     not about the registry. Here the installs are real rows, so the assertion
 *     is that the dead one is gone and the live ones (including another
 *     identity's install of the same token string) are untouched.
 *
 * Batching survives the parameterisation too.
 */

import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { pushTokens } from '../../db/schema/pushTokens';
import { users } from '../../db/schema/users';
import { pushService } from '../push.service';

let USER_ID: string;
let OTHER_USER_ID: string;

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

async function insertInstall(userId: string, token: string): Promise<void> {
  await getDb().insert(pushTokens).values({ userId, token, platform: 'ios' });
}

/** Every token registered for `userId`, oldest first. */
async function installsOf(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ token: pushTokens.token })
    .from(pushTokens)
    .where(eq(pushTokens.userId, userId))
    .orderBy(asc(pushTokens.createdAt), asc(pushTokens.token));
  return rows.map((row) => row.token);
}

function okTickets(count: number) {
  return {
    ok: true,
    json: () => Promise.resolve({ data: Array.from({ length: count }, () => ({ status: 'ok' })) }),
  };
}

const originalFetch = global.fetch;
let fetchMock: jest.Mock;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  global.fetch = originalFetch;
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  USER_ID = await insertUser();
  OTHER_USER_ID = await insertUser();
});

describe('pushService.sendPushNotification — email notification is unchanged', () => {
  it('sends the exact same wire payload the email caller always sent', async () => {
    await insertInstall(USER_ID, 'ExponentPushToken[email-device]');
    fetchMock.mockResolvedValue(okTickets(1));

    // Exactly what `email.service.ts` passes on an inbound non-spam message.
    await pushService.sendPushNotification({
      userId: USER_ID,
      title: 'Ada Lovelace',
      body: 'Analytical Engine notes',
      channelId: 'email',
      data: { messageId: 'msg-1', mailboxId: 'mbox-1' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    });

    // Byte-for-byte: same keys, same order, same values as before the change.
    expect(init.body).toBe(
      '[{"to":"ExponentPushToken[email-device]","title":"Ada Lovelace","body":"Analytical Engine notes",'
      + '"data":{"messageId":"msg-1","mailboxId":"mbox-1"},"sound":"default","channelId":"email"}]',
    );
  });

  it('targets every install of the user and NO install of anybody else', async () => {
    await insertInstall(USER_ID, 'tok-a');
    await insertInstall(USER_ID, 'tok-b');
    await insertInstall(OTHER_USER_ID, 'tok-someone-else');
    fetchMock.mockResolvedValue(okTickets(2));

    const result = await pushService.sendPushNotification({
      userId: USER_ID,
      title: 'T',
      body: 'B',
      channelId: 'email',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as Array<{ to: string }>;
    expect(sent.map((m) => m.to).sort()).toEqual(['tok-a', 'tok-b']);
    expect(result).toEqual({ targeted: 2, accepted: 2 });
  });

  it('does not call the push API when the user has no installs', async () => {
    const result = await pushService.sendPushNotification({
      userId: USER_ID,
      title: 'T',
      body: 'B',
      channelId: 'email',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ targeted: 0, accepted: 0 });
  });
});

describe('pushService — caller-supplied channel', () => {
  it('uses the channel the caller passed, with no default of its own', async () => {
    fetchMock.mockResolvedValue(okTickets(1));

    await pushService.sendPushToTokens({
      userId: USER_ID,
      tokens: ['tok-a'],
      title: 'Sign-in request',
      body: 'Open Commons to review this request.',
      channelId: 'auth-approval',
      data: { type: 'oxy_commons_auth_request', approvalUrl: 'oxycommons://approve?v=1&code=abc' },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as Array<Record<string, unknown>>;

    expect(sent).toHaveLength(1);
    expect(sent[0].channelId).toBe('auth-approval');
    // No `categoryId` — an iOS category is what binds action buttons to a
    // notification, and an approval notification must never carry one.
    expect(Object.keys(sent[0]).sort()).toEqual(['body', 'channelId', 'data', 'sound', 'title', 'to']);
  });
});

describe('pushService.sendPushToTokens — explicit targeting', () => {
  it('delivers to exactly the tokens it was given (never a registry lookup)', async () => {
    // The identity has a DIFFERENT install registered; explicit targeting must
    // ignore the registry entirely, because the caller owns the decision.
    await insertInstall(USER_ID, 'tok-registered-but-not-targeted');
    fetchMock.mockResolvedValue(okTickets(2));

    const result = await pushService.sendPushToTokens({
      userId: USER_ID,
      tokens: ['tok-a', 'tok-b'],
      title: 'T',
      body: 'B',
      channelId: 'auth-approval',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as Array<{ to: string }>;
    expect(sent.map((m) => m.to)).toEqual(['tok-a', 'tok-b']);
    expect(result).toEqual({ targeted: 2, accepted: 2 });
  });

  it('does not throw and reports zero accepted when the transport fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(
      pushService.sendPushToTokens({
        userId: USER_ID,
        tokens: ['tok-a'],
        title: 'T',
        body: 'B',
        channelId: 'auth-approval',
      }),
    ).resolves.toEqual({ targeted: 1, accepted: 0 });
  });

  it('does not throw and reports zero accepted on a non-OK push API response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: () => Promise.resolve({}) });

    await expect(
      pushService.sendPushToTokens({
        userId: USER_ID,
        tokens: ['tok-a'],
        title: 'T',
        body: 'B',
        channelId: 'auth-approval',
      }),
    ).resolves.toEqual({ targeted: 1, accepted: 0 });
  });

  it('deletes the DeviceNotRegistered install and leaves every other row alone', async () => {
    await insertInstall(USER_ID, 'tok-live');
    await insertInstall(USER_ID, 'tok-dead');
    // The same token string belonging to a DIFFERENT identity: the prune is
    // scoped to (user, token), so this row must survive.
    await insertInstall(OTHER_USER_ID, 'tok-dead');

    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { status: 'ok' },
          { status: 'error', details: { error: 'DeviceNotRegistered' } },
        ],
      }),
    });

    const result = await pushService.sendPushToTokens({
      userId: USER_ID,
      tokens: ['tok-live', 'tok-dead'],
      title: 'T',
      body: 'B',
      channelId: 'auth-approval',
    });

    expect(await installsOf(USER_ID)).toEqual(['tok-live']);
    expect(await installsOf(OTHER_USER_ID)).toEqual(['tok-dead']);
    expect(result).toEqual({ targeted: 2, accepted: 1 });
  });

  it('keeps an install the push service rejected for some OTHER reason', async () => {
    // Only `DeviceNotRegistered` retires a token. A rate-limit or a message-size
    // error is transient and must not cost the user their registration.
    await insertInstall(USER_ID, 'tok-live');
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [{ status: 'error', details: { error: 'MessageTooBig' } }],
      }),
    });

    const result = await pushService.sendPushToTokens({
      userId: USER_ID,
      tokens: ['tok-live'],
      title: 'T',
      body: 'B',
      channelId: 'auth-approval',
    });

    expect(await installsOf(USER_ID)).toEqual(['tok-live']);
    expect(result).toEqual({ targeted: 1, accepted: 0 });
  });

  it('batches at 100 messages per request', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okTickets(100)));

    const tokens = Array.from({ length: 150 }, () => `tok-${randomUUID()}`);
    await pushService.sendPushToTokens({
      userId: USER_ID,
      tokens,
      title: 'T',
      body: 'B',
      channelId: 'auth-approval',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as unknown[];
    const second = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)) as unknown[];
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(50);
  });
});
