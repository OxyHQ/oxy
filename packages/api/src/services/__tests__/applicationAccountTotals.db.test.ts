import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountClosureFences } from '../../db/schema/accountClosureFences';
import { applicationAccountTotals } from '../../db/schema/applicationAccountRegistrations';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import {
  readApplicationAccountTotal,
  registerApplicationAccounts,
} from '../applicationAccountTotals.service';

beforeAll(connectPostgres);
afterAll(closePostgres);

async function application(): Promise<string> {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning();
  if (!owner) throw new Error('owner');
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `synthetic-${randomUUID()}`, ownerAccountId: owner.id })
    .returning();
  if (!app) throw new Error('app');
  return app.id;
}
async function account(values: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', ...values })
    .returning({ id: users.id });
  if (!row) throw new Error('account');
  return row.id;
}
const ageSnapshot = (applicationId: string) =>
  getDb()
    .update(applicationAccountTotals)
    .set({ computedAt: new Date(Date.now() - 3_600_000) })
    .where(eq(applicationAccountTotals.applicationId, applicationId));

it('counts only eligible registered accounts, per application, idempotently', async () => {
  const [main, managed] = [await application(), await application()];
  const [a, b, c] = [await account(), await account(), await account()];
  const federated = await account({ type: 'federated' });
  const archived = await account({ accountStatus: 'archived' });
  const bot = await account({ kind: 'bot' });
  const fenced = await account();
  const unregistered = await account();
  await getDb().insert(accountClosureFences).values({ accountId: fenced });

  const everyone = [a, b, c, federated, archived, bot, fenced, 'no-such-account'];
  // Federated, archived, bot, fenced and unknown ids never enter the ledger.
  expect(await registerApplicationAccounts(main, everyone)).toBe(3);
  expect(await registerApplicationAccounts(main, everyone)).toBe(0);
  expect(await registerApplicationAccounts(managed, [a])).toBe(1);

  const total = await readApplicationAccountTotal(main);
  expect(total).toMatchObject({ total: 3, exact: true, stale: false, applicationId: main });
  expect((await readApplicationAccountTotal(managed)).total).toBe(1);

  // An account fenced or archived AFTER registration stops counting at the next refresh.
  await getDb().insert(accountClosureFences).values({ accountId: a });
  await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, b));
  await ageSnapshot(main);
  const stale = await readApplicationAccountTotal(main);
  expect(stale).toMatchObject({ total: 3, stale: true });
  await eventually(async () => (await readApplicationAccountTotal(main)).total, 1);
  expect(unregistered).toBeDefined();
});

it('deleting an account removes it from the count', async () => {
  const app = await application();
  const [a, b] = [await account(), await account()];
  await registerApplicationAccounts(app, [a, b]);
  expect((await readApplicationAccountTotal(app)).total).toBe(2);
  await getDb().delete(users).where(eq(users.id, a));
  await ageSnapshot(app);
  await eventually(async () => (await readApplicationAccountTotal(app)).total, 1);
});

it('reports an empty deployment as an exact zero, and many readers share one refresh', async () => {
  const app = await application();
  const readers = await Promise.all(
    Array.from({ length: 20 }, () => readApplicationAccountTotal(app)),
  );
  expect(readers.every((r) => r.total === 0 && r.exact)).toBe(true);
  const rows = await getDb()
    .select()
    .from(applicationAccountTotals)
    .where(eq(applicationAccountTotals.applicationId, app));
  expect(rows).toHaveLength(1);
});

it('keeps the last good total when a refresh fails and refuses to invent one when cold', async () => {
  const app = await application();
  await registerApplicationAccounts(app, [await account()]);
  await readApplicationAccountTotal(app);
  await ageSnapshot(app);
  const db = getDb();
  const transaction = jest.spyOn(db, 'transaction').mockRejectedValue(new Error('db down'));
  try {
    expect(await readApplicationAccountTotal(app)).toMatchObject({ total: 1, stale: true });
    await Promise.resolve();
    expect(await readApplicationAccountTotal(app)).toMatchObject({ total: 1, stale: true });
    await expect(readApplicationAccountTotal(await application())).rejects.toThrow('not available');
  } finally {
    transaction.mockRestore();
  }
});

/** Background refreshes are fire-and-forget; poll until the value settles. */
async function eventually<T>(read: () => Promise<T>, expected: T): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await read()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(await read()).toBe(expected);
}
