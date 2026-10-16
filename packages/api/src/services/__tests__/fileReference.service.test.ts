/**
 * `resolveReferenceApplicationId` — the runtime twin of migration 0167's
 * resolver — against a REAL Postgres.
 *
 * Every application seeded here carries a random name except the ones a case
 * resolves by name; for those, same-named rows a sibling suite left in this
 * worker's database are suspended first, so they cannot change an answer.
 */

import { randomBytes } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, users } from '../../db/schema';
import { resolveReferenceApplicationId } from '../fileReference.service';

jest.setTimeout(60_000);

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function application(values: Partial<typeof applications.$inferInsert> = {}) {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `app-${randomBytes(4).toString('hex')}`,
      ownerAccountId: await account(),
      type: 'first_party',
      ...values,
    })
    .returning({ id: applications.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('resolveReferenceApplicationId', () => {
  it('resolves an active application by its own id, whatever its type', async () => {
    const thirdParty = await application({ type: 'third_party' });
    const suspended = await application({ status: 'suspended' });

    expect(await resolveReferenceApplicationId(thirdParty)).toBe(thirdParty);
    expect(await resolveReferenceApplicationId(suspended)).toBeNull();
  });

  it('resolves a legacy alias by the seed’s fixed id', async () => {
    const goway = '73176d04c3654667138c23ec';
    // Upserted, not inserted: other suites in this worker's database seed and
    // suspend the same fixed row (`gowaySeedRollback.test.ts`).
    await getDb()
      .insert(applications)
      .values({ id: goway, name: 'GoWay', ownerAccountId: await account(), type: 'first_party' })
      .onConflictDoUpdate({
        target: applications.id,
        set: { name: 'GoWay', type: 'first_party', status: 'active' },
      });

    // A same-named official row left by a sibling suite would make the alias
    // ambiguous; this case is about the fixed id.
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(and(eq(applications.name, 'GoWay'), ne(applications.id, goway)));

    expect(await resolveReferenceApplicationId('goway')).toBe(goway);
  });

  it('resolves a legacy alias by an official seed name — never a third party’s, and only when one matches', async () => {
    const existing = await getDb()
      .select({ id: applications.id })
      .from(applications)
      .where(inArray(applications.name, ['Oxy Accounts']));
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(
        inArray(
          applications.id,
          existing.map((row) => row.id),
        ),
      );

    await application({ name: 'Oxy Accounts', type: 'third_party' });
    expect(await resolveReferenceApplicationId('profiles')).toBeNull();

    const accounts = await application({ name: 'Oxy Accounts' });
    expect(await resolveReferenceApplicationId('profiles')).toBe(accounts);

    await application({ name: 'Oxy Accounts', type: 'internal' });
    expect(await resolveReferenceApplicationId('profiles')).toBeNull();
  });

  it('resolves free text to nothing', async () => {
    expect(await resolveReferenceApplicationId('mention')).toBeNull();
    expect(await resolveReferenceApplicationId('')).toBeNull();
  });
});
