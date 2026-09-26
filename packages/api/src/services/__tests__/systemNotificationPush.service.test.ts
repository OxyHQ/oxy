/**
 * Push delivery of a `system` notification, against a REAL Postgres registry.
 *
 * The guarantees: the push reaches the recipient's VAULT installs (an active
 * application carrying `identity:approval`) and nothing else, it carries only
 * the notification id as data, and a recipient who turned push off gets none.
 *
 * Only the Expo transport (`push.service`) is mocked — what matters is which
 * tokens it is handed and with what.
 */

import { randomUUID } from 'node:crypto';

const mockSendPushToTokens = jest.fn();

jest.mock('../push.service', () => ({
  __esModule: true,
  pushService: { sendPushToTokens: mockSendPushToTokens },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { OXY_ACCOUNT_PUSH_CHANNEL, OXY_SYSTEM_NOTIFICATION_PUSH_TYPE } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { pushTokens } from '../../db/schema/pushTokens';
import { users } from '../../db/schema/users';
import { IDENTITY_APPROVAL_CAPABILITY } from '../../utils/applicationCapabilities';
import { pushSystemNotification } from '../systemNotificationPush.service';

let USER_ID: string;
let VAULT_APP_ID: string;
let OTHER_APP_ID: string;

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

async function insertApplication(capabilities: string[]): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ownerAccountId: await insertUser(), capabilities })
    .returning({ id: applications.id });
  return row.id;
}

async function insertInstall(userId: string, token: string, applicationId: string | null): Promise<void> {
  await getDb().insert(pushTokens).values({ userId, token, platform: 'android', applicationId });
}

const NOTIFICATION = {
  notificationId: 'n-1',
  title: 'Your Mastodon account moved',
  message: '312 followers came with you.',
} as const;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockSendPushToTokens.mockResolvedValue({ targeted: 1, accepted: 1 });
  USER_ID = await insertUser();
  VAULT_APP_ID = await insertApplication([IDENTITY_APPROVAL_CAPABILITY]);
  OTHER_APP_ID = await insertApplication([]);
});

describe('pushSystemNotification', () => {
  it("pushes the notification's text to the vault install only, carrying just its id", async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    await insertInstall(USER_ID, 'tok-inbox', OTHER_APP_ID);
    await insertInstall(USER_ID, 'tok-unscoped', null);

    const result = await pushSystemNotification({ recipientId: USER_ID, ...NOTIFICATION });

    expect(result).toEqual({ targeted: 1, accepted: 1 });
    expect(mockSendPushToTokens).toHaveBeenCalledTimes(1);
    expect(mockSendPushToTokens).toHaveBeenCalledWith({
      userId: USER_ID,
      tokens: ['tok-vault'],
      title: NOTIFICATION.title,
      body: NOTIFICATION.message,
      channelId: OXY_ACCOUNT_PUSH_CHANNEL,
      data: { type: OXY_SYSTEM_NOTIFICATION_PUSH_TYPE, notificationId: 'n-1' },
    });
  });

  it('sends nothing when the recipient turned push notifications off', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    await getDb().update(users).set({ notificationPushEnabled: false }).where(eq(users.id, USER_ID));

    const result = await pushSystemNotification({ recipientId: USER_ID, ...NOTIFICATION });

    expect(result).toEqual({ targeted: 0, accepted: 0 });
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });

  it('sends nothing when the recipient has no vault install', async () => {
    await insertInstall(USER_ID, 'tok-inbox', OTHER_APP_ID);

    await pushSystemNotification({ recipientId: USER_ID, ...NOTIFICATION });

    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });

  it('never throws when the transport does', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    mockSendPushToTokens.mockRejectedValue(new Error('exp.host down'));

    await expect(pushSystemNotification({ recipientId: USER_ID, ...NOTIFICATION })).resolves.toEqual({
      targeted: 0,
      accepted: 0,
    });
  });
});
