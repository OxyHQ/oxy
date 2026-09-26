/**
 * The operator deletion script's guards, against a REAL Postgres.
 *
 * What matters is what it refuses: anything but an active local personal
 * account, an unknown name, an account with a financial hold — and that one
 * refusal stops the whole run, and a dry run changes nothing. The destructive
 * side systems the deletion workflow calls (mail, sessions, devices, the social
 * graph, caches) are stubbed; the workflow itself has the route's tests.
 */

import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

jest.mock('../../services/email.service', () => ({
  emailService: { deleteAllUserData: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { deactivateAllUserSessions: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/deviceSession.service', () => ({
  __esModule: true,
  default: { purgeAccountFromAllDevices: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/user.service', () => ({
  userService: { purgeUserSocialGraph: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../utils/graphCache', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), invalidate: jest.fn() },
}));
jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import * as holdsService from '../../services/accountFinancialHolds.service';
import { parseDeleteAccountsArgs, planAccountDeletions, runAccountDeletions } from '../delete-accounts';

jest.setTimeout(60_000);

function handle(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

async function account(values: Partial<typeof users.$inferInsert> = {}): Promise<{ id: string; username: string }> {
  const username = values.username ?? handle('del');
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', username, ...values })
    .returning({ id: users.id });
  return { id: row.id, username };
}

async function exists(ids: string[]): Promise<string[]> {
  const rows = await getDb().select({ id: users.id }).from(users).where(inArray(users.id, ids));
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('parseDeleteAccountsArgs', () => {
  it('is a dry run unless --confirm is given', () => {
    expect(parseDeleteAccountsArgs(['alice', 'bob'])).toEqual({ identifiers: ['alice', 'bob'], confirm: false });
    expect(parseDeleteAccountsArgs(['alice', '--confirm'])).toEqual({ identifiers: ['alice'], confirm: true });
  });

  it('refuses no account and unknown options', () => {
    expect(() => parseDeleteAccountsArgs([])).toThrow(/at least one account/);
    expect(() => parseDeleteAccountsArgs(['--confirm'])).toThrow(/at least one account/);
    expect(() => parseDeleteAccountsArgs(['alice', '--force'])).toThrow(/Unknown option/);
  });
});

describe('planAccountDeletions', () => {
  it('plans an active local personal account by username (any case) or id, without touching it', async () => {
    const byName = await account({ email: `${handle('m')}@example.com` });
    const byId = await account();

    const plan = await planAccountDeletions([byName.username.toUpperCase(), byId.id, byId.username]);

    expect(plan.refused).toEqual([]);
    expect(plan.planned.map((entry) => entry.id)).toEqual([byName.id, byId.id]);
    expect(plan.planned[0]).toMatchObject({ outcome: 'delete', hasEmail: true, hasKey: false });
    // The plan never carries the address itself.
    expect(JSON.stringify(plan)).not.toContain('@example.com');
    expect(await exists([byName.id, byId.id])).toHaveLength(2);
  });

  it('refuses unknown, non-personal, non-local and closed accounts', async () => {
    const federated = await account({ type: 'federated' });
    const bot = await account({ kind: 'bot' });
    const archived = await account({ accountStatus: 'archived' });
    const missing = handle('nobody');

    const plan = await planAccountDeletions([missing, federated.username, bot.username, archived.username]);

    expect(plan.planned).toEqual([]);
    expect(plan.refused).toEqual([
      { identifier: missing, reason: 'no such account' },
      { identifier: federated.username, reason: expect.stringMatching(/not a local personal account/) },
      { identifier: bot.username, reason: expect.stringMatching(/not a local personal account/) },
      { identifier: archived.username, reason: 'account is archived' },
    ]);
  });

  it('refuses an account with a live subscription, as the route does', async () => {
    const subscribed = await account();
    const real = holdsService.describeAccountFinancialHolds;
    jest.spyOn(holdsService, 'describeAccountFinancialHolds').mockImplementation(async (id) => ({
      ...(await real(id)),
      liveSubscriptionIds: ['sub_1'],
      hasLiveSubscription: true,
    }));

    const plan = await planAccountDeletions([subscribed.username]);

    expect(plan.planned).toEqual([]);
    expect(plan.refused).toEqual([{ identifier: subscribed.username, reason: expect.stringMatching(/live subscription/) }]);
  });
});

describe('runAccountDeletions', () => {
  it('deletes nothing on a dry run', async () => {
    const target = await account();
    const report = await runAccountDeletions({ identifiers: [target.username], confirm: false });
    expect(report.plan.planned).toHaveLength(1);
    expect(report.results).toEqual([]);
    expect(await exists([target.id])).toEqual([target.id]);
  });

  it('deletes nothing when any account is refused, even with --confirm', async () => {
    const target = await account();
    const federated = await account({ type: 'federated' });
    const report = await runAccountDeletions({ identifiers: [target.username, federated.username], confirm: true });
    expect(report.plan.refused).toHaveLength(1);
    expect(report.results).toEqual([]);
    expect(await exists([target.id, federated.id])).toHaveLength(2);
  });

  it('deletes every planned account with --confirm, through the one workflow', async () => {
    const first = await account();
    const second = await account();
    const report = await runAccountDeletions({ identifiers: [first.username, second.id], confirm: true });
    expect(report.results.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(report.results.every((entry) => entry.result.retained === false)).toBe(true);
    expect(await exists([first.id, second.id])).toEqual([]);
    const [gone] = await getDb().select({ id: users.id }).from(users).where(eq(users.username, first.username));
    expect(gone).toBeUndefined();
  });
});
