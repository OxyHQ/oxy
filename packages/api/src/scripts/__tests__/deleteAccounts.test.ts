/**
 * The operator deletion script's guards, against a REAL Postgres.
 *
 * What matters is what it refuses: anything but a STRANDED active local
 * personal account (no key, no email — its owner cannot delete it), an
 * unknown name, an account with a financial hold; that one refusal in the
 * plan stops the whole run; that an account changed after the plan is caught
 * under a row lock; and that a dry run changes nothing. The destructive
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
import { parseDeleteAccountsArgs, planAccountDeletions, recheckPlannedAccount, runAccountDeletions } from '../delete-accounts';

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
  it('plans a stranded account by username (any case) or id, without touching it', async () => {
    const byName = await account();
    const byId = await account();

    const plan = await planAccountDeletions([byName.username.toUpperCase(), byId.id, byId.username]);

    expect(plan.refused).toEqual([]);
    expect(plan.planned.map((entry) => entry.id)).toEqual([byName.id, byId.id]);
    expect(plan.planned[0]).toMatchObject({ outcome: 'delete', username: byName.username });
    expect(await exists([byName.id, byId.id])).toHaveLength(2);
  });

  it('refuses an account its owner can delete: one with a key, one with an email', async () => {
    const keyed = await account({ publicKey: `04${randomUUID().replace(/-/g, '')}` });
    const withEmail = await account({ email: `${handle('m')}@example.com` });

    const plan = await planAccountDeletions([keyed.username, withEmail.username]);

    expect(plan.planned).toEqual([]);
    expect(plan.refused).toEqual([
      { identifier: keyed.username, reason: expect.stringMatching(/has a key/) },
      { identifier: withEmail.username, reason: expect.stringMatching(/has an email/) },
    ]);
    // The refusal never carries the address itself.
    expect(JSON.stringify(plan)).not.toContain('@example.com');
    expect(await exists([keyed.id, withEmail.id])).toHaveLength(2);
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

  it('re-reads the row under a lock and refuses an account that changed since the plan', async () => {
    const target = await account();
    const [planned] = (await planAccountDeletions([target.username])).planned;
    expect(await recheckPlannedAccount(planned)).toBeNull();

    await getDb().update(users).set({ email: `${handle('late')}@example.com` }).where(eq(users.id, target.id));
    expect(await recheckPlannedAccount(planned)).toBe('has an email now');
    await getDb().update(users).set({ email: null, publicKey: `04${randomUUID().replace(/-/g, '')}` }).where(eq(users.id, target.id));
    expect(await recheckPlannedAccount(planned)).toBe('has a key now');
    await getDb().update(users).set({ publicKey: null, accountStatus: 'archived' }).where(eq(users.id, target.id));
    expect(await recheckPlannedAccount(planned)).toBe('is now archived');
    await getDb().update(users).set({ accountStatus: 'active', kind: 'bot' }).where(eq(users.id, target.id));
    expect(await recheckPlannedAccount(planned)).toBe('is no longer a local personal account');
  });

  it('stops the run at an account that changed after the plan, keeping what it already deleted', async () => {
    const first = await account();
    const second = await account();
    const deletion = await import('../../services/accountDeletion.service');
    const real = deletion.deleteAccount;
    // Between the first deletion and the second: the second account gains an email.
    jest.spyOn(deletion, 'deleteAccount').mockImplementation(async (id, username) => {
      const result = await real(id, username);
      if (id === first.id) {
        await getDb().update(users).set({ email: `${handle('race')}@example.com` }).where(eq(users.id, second.id));
      }
      return result;
    });

    const report = await runAccountDeletions({ identifiers: [first.username, second.username], confirm: true });

    expect(report.results.map((entry) => entry.id)).toEqual([first.id]);
    expect(report.aborted).toEqual({ identifier: second.username, reason: 'changed since the plan: has an email now' });
    expect(await exists([first.id, second.id])).toEqual([second.id]);
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
