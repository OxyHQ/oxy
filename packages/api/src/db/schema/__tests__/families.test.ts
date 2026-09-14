/**
 * `families` / `family_members` invariants NOT already covered by the generic
 * table-scanning gates (`schemaInvariants.test.ts`, `constraints.test.ts`,
 * `foreignKeys.test.ts`, `protectedColumns.test.ts` all run against these
 * tables automatically because they are in the schema barrel). This file
 * covers what is specific to Family: the CHECK vocabularies, the compound
 * unique, the PARTIAL unique index carrying the "at most one organizer per
 * family" invariant (a person may hold any number of ACTIVE family
 * memberships — see the module header on `../families.ts`), and what
 * deleting a family or a user actually does to a membership row.
 *
 * Same helpers and style as `constraints.test.ts` — a real Postgres through
 * the application's own pool, no mock.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { families, familyMembers } from '../families';
import { users } from '../users';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

/** A real `personal` user — every `member_user_id` / `invited_by_user_id` carries a foreign key. */
async function personalUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function family(name?: string): Promise<string> {
  const [row] = await getDb().insert(families).values({ name }).returning({ id: families.id });
  return row.id;
}

/** The SQLSTATE a driver error carries — walks `cause`, same as `constraints.test.ts`. */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Await a query expecting rejection, returning the error (runs the query exactly once). */
async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('family_members — closed value sets', () => {
  it('rejects an undeclared role from a raw write', async () => {
    // Raw SQL on purpose: the typed column already refuses this at compile
    // time, so only a hand-written statement (backfill, psql) can reach the
    // constraint — which is precisely who it has to stop.
    const error = await rejection(
      getDb().execute(sql`
        insert into family_members (id, family_id, member_user_id, role, status)
        values (${randomUUID()}, ${await family()}, ${await personalUser()}, 'admin', 'active')
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('rejects an undeclared status from a raw write', async () => {
    const error = await rejection(
      getDb().execute(sql`
        insert into family_members (id, family_id, member_user_id, role, status)
        values (${randomUUID()}, ${await family()}, ${await personalUser()}, 'member', 'pending')
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});

describe('family_members — compound unique (family, member)', () => {
  it('rejects a second row for the same (family, member) pair', async () => {
    const familyId = await family();
    const memberUserId = await personalUser();
    await getDb().insert(familyMembers).values({ familyId, memberUserId, role: 'member', status: 'invited' });

    const error = await rejection(
      getDb().insert(familyMembers).values({ familyId, memberUserId, role: 'member', status: 'invited' })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('allows the same person to hold rows on two different families', async () => {
    const memberUserId = await personalUser();
    await getDb().insert(familyMembers).values({ familyId: await family(), memberUserId, role: 'member', status: 'invited' });

    await expect(
      getDb().insert(familyMembers).values({ familyId: await family(), memberUserId, role: 'member', status: 'invited' })
    ).resolves.toBeDefined();
  });
});

describe('family_members — a person may be ACTIVE in more than one family', () => {
  it('allows a second ACTIVE row for the same person across two families', async () => {
    // Separated parents' households, a blended family, shared custody: one
    // person genuinely belongs to more than one family at once, so nothing
    // here restricts how many ACTIVE rows one member_user_id may hold.
    const memberUserId = await personalUser();
    await getDb()
      .insert(familyMembers)
      .values({ familyId: await family(), memberUserId, role: 'organizer', status: 'active' });

    await expect(
      getDb()
        .insert(familyMembers)
        .values({ familyId: await family(), memberUserId, role: 'member', status: 'active' })
    ).resolves.toBeDefined();
  });
});

describe('family_members — at most one ACTIVE organizer per family', () => {
  it('rejects a second active organizer on the same family', async () => {
    const familyId = await family();
    await getDb()
      .insert(familyMembers)
      .values({ familyId, memberUserId: await personalUser(), role: 'organizer', status: 'active' });

    const error = await rejection(
      getDb()
        .insert(familyMembers)
        .values({ familyId, memberUserId: await personalUser(), role: 'organizer', status: 'active' })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('allows any number of active plain members on the same family', async () => {
    const familyId = await family();
    await getDb()
      .insert(familyMembers)
      .values({ familyId, memberUserId: await personalUser(), role: 'organizer', status: 'active' });

    await expect(
      getDb()
        .insert(familyMembers)
        .values({ familyId, memberUserId: await personalUser(), role: 'member', status: 'active' })
    ).resolves.toBeDefined();
    await expect(
      getDb()
        .insert(familyMembers)
        .values({ familyId, memberUserId: await personalUser(), role: 'member', status: 'active' })
    ).resolves.toBeDefined();
  });

  it('allows two different families to each have their own active organizer', async () => {
    await getDb()
      .insert(familyMembers)
      .values({ familyId: await family(), memberUserId: await personalUser(), role: 'organizer', status: 'active' });

    await expect(
      getDb()
        .insert(familyMembers)
        .values({ familyId: await family(), memberUserId: await personalUser(), role: 'organizer', status: 'active' })
    ).resolves.toBeDefined();
  });
});

describe('family_members — what deleting a row on either side actually does', () => {
  it('CASCADEs when the family is deleted', async () => {
    const familyId = await family();
    const [{ id: membershipId }] = await getDb()
      .insert(familyMembers)
      .values({ familyId, memberUserId: await personalUser(), role: 'organizer', status: 'active' })
      .returning({ id: familyMembers.id });

    await getDb().delete(families).where(eq(families.id, familyId));

    const [row] = await getDb().select().from(familyMembers).where(eq(familyMembers.id, membershipId));
    expect(row).toBeUndefined();
  });

  it('CASCADEs when the member user is deleted', async () => {
    const memberUserId = await personalUser();
    const [{ id: membershipId }] = await getDb()
      .insert(familyMembers)
      .values({ familyId: await family(), memberUserId, role: 'organizer', status: 'active' })
      .returning({ id: familyMembers.id });

    await getDb().delete(users).where(eq(users.id, memberUserId));

    const [row] = await getDb().select().from(familyMembers).where(eq(familyMembers.id, membershipId));
    expect(row).toBeUndefined();
  });

  it('SET NULLs invited_by_user_id when the inviter is deleted, keeping the membership', async () => {
    const inviterId = await personalUser();
    const memberUserId = await personalUser();
    const familyId = await family();
    const [{ id: membershipId }] = await getDb()
      .insert(familyMembers)
      .values({
        familyId,
        memberUserId,
        role: 'member',
        status: 'invited',
        invitedByUserId: inviterId,
      })
      .returning({ id: familyMembers.id });

    await getDb().delete(users).where(eq(users.id, inviterId));

    const [row] = await getDb().select().from(familyMembers).where(eq(familyMembers.id, membershipId));
    expect(row).toBeDefined();
    expect(row.invitedByUserId).toBeNull();
  });
});
