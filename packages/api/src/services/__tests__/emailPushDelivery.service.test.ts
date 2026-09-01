/**
 * Scoped Inbox email push delivery, against a REAL Postgres registry.
 *
 * ## The guarantee this file exists for
 *
 * A new-mail push reaches the identity's **Inbox** installs and NOTHING else —
 * not their Commons install, not an install that named no application at all,
 * and not another identity's Inbox install. Mail alerts leaking into the vault
 * app on the same account is the failure this scoping was added to prevent.
 *
 * ## Why the previous version could not prove it
 *
 * It replaced `models/PushToken` with a `jest.fn()` and asserted that the stub
 * had been CALLED with `{ userId, applicationId }`. That is a claim about a
 * query object, not about which rows come back: it holds just as well when the
 * filter selects the wrong installs, and it cannot see an install that should
 * have been EXCLUDED, because no install exists. Here every install is a real
 * row and every assertion is about which of them the push transport was handed.
 *
 * ## What stays mocked, and why
 *
 * Only two boundaries:
 *
 *  - `resolveApplicationIdFromClientId` — the subject here is the SCOPING, not
 *    the `clientId` → `applicationId` resolution. That resolution is one join
 *    over `application_credentials` and `applications` with its own real-Postgres
 *    suite (`utils/__tests__/resolveApplicationFromClientId.test.ts`), and the
 *    Inbox client id it is keyed on is an environment value. Mocking it lets the
 *    application id under test be a REAL `applications` row this file inserted,
 *    which is what makes the foreign key — and therefore the scoping — real.
 *  - `push.service` — an HTTP client for `exp.host` with its own suite. What
 *    matters here is which tokens it is handed.
 */

import { randomUUID } from 'node:crypto';

const mockSendPushToTokens = jest.fn();
const mockResolveApplicationId = jest.fn();

jest.mock('../../utils/resolveApplicationFromClientId', () => ({
  __esModule: true,
  resolveApplicationIdFromClientId: (...args: unknown[]) => mockResolveApplicationId(...args),
}));

jest.mock('../push.service', () => ({
  __esModule: true,
  pushService: { sendPushToTokens: mockSendPushToTokens },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { INBOX_EMAIL_PUSH_CHANNEL, INBOX_EMAIL_PUSH_TYPE } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { pushTokens } from '../../db/schema/pushTokens';
import { users } from '../../db/schema/users';
import { sendInboxEmailPush } from '../emailPushDelivery.service';

let USER_ID: string;
let OTHER_USER_ID: string;
/** The Inbox application — the only one email push may reach. */
let INBOX_APP_ID: string;
/** Another Oxy app on the same account (stands in for Commons). */
let OTHER_APP_ID: string;

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

async function insertApplication(): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ownerAccountId: await insertUser() })
    .returning({ id: applications.id });
  return row.id;
}

async function insertInstall(
  userId: string,
  token: string,
  applicationId: string | null,
): Promise<void> {
  await getDb().insert(pushTokens).values({ userId, token, platform: 'ios', applicationId });
}

/** The tokens the push transport was handed, in the order it received them. */
function pushedTokens(): string[] {
  return (mockSendPushToTokens.mock.calls[0]?.[0] as { tokens: string[] } | undefined)?.tokens ?? [];
}

const MAIL = {
  title: 'Ada Lovelace',
  body: 'Analytical Engine notes',
  messageId: 'msg-1',
  mailboxId: 'mbox-1',
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
  // Fresh rows per case: a real unique index on (user_id, token) and a real
  // foreign key on application_id mean a leftover install would decide the
  // next case.
  USER_ID = await insertUser();
  OTHER_USER_ID = await insertUser();
  INBOX_APP_ID = await insertApplication();
  OTHER_APP_ID = await insertApplication();
  mockResolveApplicationId.mockImplementation(() => Promise.resolve(INBOX_APP_ID));
});

describe('sendInboxEmailPush — mail reaches Inbox installs and nothing else', () => {
  it("targets the Inbox install and NOT the same account's other-app install", async () => {
    await insertInstall(USER_ID, 'tok-inbox', INBOX_APP_ID);
    await insertInstall(USER_ID, 'tok-commons', OTHER_APP_ID);

    await sendInboxEmailPush({ userId: USER_ID, ...MAIL });

    expect(pushedTokens()).toEqual(['tok-inbox']);
  });

  it('never targets an UNSCOPED install (application_id NULL)', async () => {
    // An install registered without a `clientId`. NULL there means "not scoped
    // to any application", which is emphatically not "scoped to Inbox" — and a
    // SQL equality is never true for NULL, so it is excluded by construction.
    await insertInstall(USER_ID, 'tok-inbox', INBOX_APP_ID);
    await insertInstall(USER_ID, 'tok-unscoped', null);

    await sendInboxEmailPush({ userId: USER_ID, ...MAIL });

    expect(pushedTokens()).toEqual(['tok-inbox']);
  });

  it("never targets another identity's Inbox install", async () => {
    await insertInstall(USER_ID, 'tok-mine', INBOX_APP_ID);
    await insertInstall(OTHER_USER_ID, 'tok-theirs', INBOX_APP_ID);

    await sendInboxEmailPush({ userId: USER_ID, ...MAIL });

    expect(pushedTokens()).toEqual(['tok-mine']);
  });

  it('targets every Inbox install the identity owns', async () => {
    await insertInstall(USER_ID, 'tok-phone', INBOX_APP_ID);
    await insertInstall(USER_ID, 'tok-tablet', INBOX_APP_ID);

    await sendInboxEmailPush({ userId: USER_ID, ...MAIL });

    expect(pushedTokens().sort()).toEqual(['tok-phone', 'tok-tablet']);
  });

  it('resolves the Inbox application from the Inbox client id, not a hardcoded row', async () => {
    await insertInstall(USER_ID, 'tok-inbox', INBOX_APP_ID);

    await sendInboxEmailPush({ userId: USER_ID, ...MAIL });

    expect(mockResolveApplicationId).toHaveBeenCalledWith(expect.stringMatching(/^oxy_dk_/));
  });
});

describe('sendInboxEmailPush — the payload', () => {
  it('carries the email push type, channel and message coordinates', async () => {
    await insertInstall(USER_ID, 'tok-inbox', INBOX_APP_ID);

    await sendInboxEmailPush({ userId: USER_ID, ...MAIL });

    expect(mockSendPushToTokens).toHaveBeenCalledWith({
      userId: USER_ID,
      tokens: ['tok-inbox'],
      title: 'Ada Lovelace',
      body: 'Analytical Engine notes',
      channelId: INBOX_EMAIL_PUSH_CHANNEL,
      data: {
        type: INBOX_EMAIL_PUSH_TYPE,
        messageId: 'msg-1',
        mailboxId: 'mbox-1',
      },
    });
  });
});

describe('sendInboxEmailPush — nothing is sent when there is nothing to send', () => {
  it('sends nothing when the identity has no Inbox install', async () => {
    // They DO have an install — of another app. That must not become a target
    // just because the Inbox set is empty.
    await insertInstall(USER_ID, 'tok-commons', OTHER_APP_ID);

    await sendInboxEmailPush({ userId: USER_ID, ...MAIL });

    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });

  it('sends nothing when the Inbox application cannot be resolved', async () => {
    // A revoked credential or a suspended application. Falling back to "every
    // install this identity owns" would be exactly the leak the scoping exists
    // to prevent, so an unresolved application means no delivery at all.
    await insertInstall(USER_ID, 'tok-inbox', INBOX_APP_ID);
    await insertInstall(USER_ID, 'tok-commons', OTHER_APP_ID);
    mockResolveApplicationId.mockResolvedValue(null);

    await sendInboxEmailPush({ userId: USER_ID, ...MAIL });

    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });
});

describe('sendInboxEmailPush — fire and forget', () => {
  it('never throws when the push transport fails', async () => {
    await insertInstall(USER_ID, 'tok-inbox', INBOX_APP_ID);
    mockSendPushToTokens.mockRejectedValue(new Error('network down'));

    await expect(sendInboxEmailPush({ userId: USER_ID, ...MAIL })).resolves.toBeUndefined();
  });

  it('never throws when the application lookup fails', async () => {
    mockResolveApplicationId.mockRejectedValue(new Error('database down'));

    await expect(sendInboxEmailPush({ userId: USER_ID, ...MAIL })).resolves.toBeUndefined();
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });
});
