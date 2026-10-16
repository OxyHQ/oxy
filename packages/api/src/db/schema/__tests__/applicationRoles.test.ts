/**
 * The application-roles tables against a REAL Postgres: the key CHECK, the
 * live-row unique indexes, and the two hand-written write guards
 * (`applicationRolesImmutability.ts`).
 *
 * Every refusal asserts the guard's OWN sentence, never just `SQLSTATE 23514`:
 * the tables carry CHECK constraints that raise 23514 too, so a code-only
 * assertion would stay green against a dropped trigger. And every refusal has a
 * positive control — the permitted edit on the same row — so the only thing that
 * can be refusing is the guard.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { applicationRoleGrants, applicationRolePermissions } from '../applicationRoles';
import {
  APPLICATION_ROLE_GRANTS_TRIGGER,
  APPLICATION_ROLE_GRANT_IMMUTABLE_MESSAGE,
  APPLICATION_ROLE_PERMISSIONS_TRIGGER,
  APPLICATION_ROLE_PERMISSION_IMMUTABLE_MESSAGE,
  APPLICATION_ROLES_HAND_WRITTEN_DDL,
} from '../applicationRolesImmutability';
import { applications } from '../applications';
import { users } from '../users';

const MIGRATION_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'drizzle',
  '0167_application_roles.sql',
);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

function tag(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }
  return messages;
}

async function expectRefused(work: Promise<unknown>, message: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(errorMessages(error).some((text) => text.includes(message))).toBe(true);
    return;
  }
  throw new Error(`expected the write to be refused with "${message}", but it succeeded`);
}

async function seedUser(): Promise<string> {
  const t = tag();
  const [row] = await getDb()
    .insert(users)
    .values({ username: `roles-${t}`, email: `roles-${t}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

async function seedFixture() {
  const owner = await seedUser();
  const granter = await seedUser();
  const grantee = await seedUser();
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Roles ${tag()}`, ownerAccountId: owner })
    .returning({ id: applications.id });
  const [permission] = await getDb()
    .insert(applicationRolePermissions)
    .values({
      applicationId: application.id,
      key: 'payments.operate',
      description: 'Run the payments desk',
      declaredByUserId: granter,
    })
    .returning({ id: applicationRolePermissions.id });
  const [grant] = await getDb()
    .insert(applicationRoleGrants)
    .values({ permissionId: permission.id, userId: grantee, grantedByUserId: granter })
    .returning({ id: applicationRoleGrants.id });
  return {
    owner,
    granter,
    grantee,
    applicationId: application.id,
    permissionId: permission.id,
    grantId: grant.id,
  };
}

describe('the migration carries the hand-written guards', () => {
  it('contains every statement verbatim and exactly one deploy-phase marker', () => {
    const migration = readFileSync(MIGRATION_PATH, 'utf8');
    for (const statement of APPLICATION_ROLES_HAND_WRITTEN_DDL) {
      expect(migration).toContain(statement);
    }
    expect(migration.match(/^-- oxy:deploy-phase=/gm)).toEqual(['-- oxy:deploy-phase=']);
    expect(migration).toContain('-- oxy:deploy-phase=pre');
  });

  it('installed both triggers', async () => {
    const rows = await getDb().execute<{ tgname: string }>(
      sql`select tgname from pg_trigger where tgname in (${APPLICATION_ROLE_GRANTS_TRIGGER}, ${APPLICATION_ROLE_PERMISSIONS_TRIGGER}) and not tgisinternal order by tgname`,
    );
    expect(Array.from(rows).map((row) => row.tgname)).toEqual([
      APPLICATION_ROLE_GRANTS_TRIGGER,
      APPLICATION_ROLE_PERMISSIONS_TRIGGER,
    ]);
  });
});

describe('application_role_permissions', () => {
  it('refuses a colon-spelled or one-segment key at the database', async () => {
    const { applicationId } = await seedFixture();
    for (const key of ['payments:operate', 'payments', 'Payments.operate']) {
      await expect(
        getDb().insert(applicationRolePermissions).values({ applicationId, key, description: 'x' }),
      ).rejects.toThrow();
    }
    // Control: a well-formed key with the same everything else is accepted.
    await getDb()
      .insert(applicationRolePermissions)
      .values({ applicationId, key: 'refunds.operate', description: 'x' });
  });

  it('holds one LIVE row per key; a retired key may be declared again', async () => {
    const { applicationId, permissionId } = await seedFixture();
    await expect(
      getDb()
        .insert(applicationRolePermissions)
        .values({ applicationId, key: 'payments.operate', description: 'dup' }),
    ).rejects.toThrow();
    await getDb()
      .update(applicationRolePermissions)
      .set({ retiredAt: new Date() })
      .where(eq(applicationRolePermissions.id, permissionId));
    await getDb()
      .insert(applicationRolePermissions)
      .values({ applicationId, key: 'payments.operate', description: 'again' });
  });

  it('refuses a rename, an un-retire and editing a retired description; admits a live re-description', async () => {
    const { permissionId } = await seedFixture();
    // Control: a live key's description may change.
    await getDb()
      .update(applicationRolePermissions)
      .set({ description: 'Decide customer remedies' })
      .where(eq(applicationRolePermissions.id, permissionId));

    await expectRefused(
      getDb()
        .update(applicationRolePermissions)
        .set({ key: 'refunds.operate' })
        .where(eq(applicationRolePermissions.id, permissionId)),
      APPLICATION_ROLE_PERMISSION_IMMUTABLE_MESSAGE,
    );

    const retirer = await seedUser();
    await getDb()
      .update(applicationRolePermissions)
      .set({ retiredAt: new Date(), retiredByUserId: retirer })
      .where(eq(applicationRolePermissions.id, permissionId));

    await expectRefused(
      getDb()
        .update(applicationRolePermissions)
        .set({ retiredAt: null, retiredByUserId: null })
        .where(eq(applicationRolePermissions.id, permissionId)),
      APPLICATION_ROLE_PERMISSION_IMMUTABLE_MESSAGE,
    );
    await expectRefused(
      getDb()
        .update(applicationRolePermissions)
        .set({ description: 'rewritten history' })
        .where(eq(applicationRolePermissions.id, permissionId)),
      APPLICATION_ROLE_PERMISSION_IMMUTABLE_MESSAGE,
    );
    await expectRefused(
      getDb()
        .update(applicationRolePermissions)
        .set({ retiredByUserId: null })
        .where(eq(applicationRolePermissions.id, permissionId)),
      APPLICATION_ROLE_PERMISSION_IMMUTABLE_MESSAGE,
    );

    // Erasing the retirer is the one path that clears it.
    await getDb().delete(users).where(eq(users.id, retirer));
    const [row] = await getDb()
      .select({ retiredByUserId: applicationRolePermissions.retiredByUserId })
      .from(applicationRolePermissions)
      .where(eq(applicationRolePermissions.id, permissionId));
    expect(row?.retiredByUserId).toBeNull();
  });
});

describe('application_role_grants', () => {
  it('admits ONE revocation and refuses every other edit', async () => {
    const { grantId, granter, owner } = await seedFixture();

    await expectRefused(
      getDb()
        .update(applicationRoleGrants)
        .set({ grantReason: 'back-filled excuse' })
        .where(eq(applicationRoleGrants.id, grantId)),
      APPLICATION_ROLE_GRANT_IMMUTABLE_MESSAGE,
    );
    await expectRefused(
      getDb()
        .update(applicationRoleGrants)
        .set({ userId: owner })
        .where(eq(applicationRoleGrants.id, grantId)),
      APPLICATION_ROLE_GRANT_IMMUTABLE_MESSAGE,
    );
    await expectRefused(
      getDb()
        .update(applicationRoleGrants)
        .set({ revokedAt: new Date(), grantReason: 'smuggled' })
        .where(eq(applicationRoleGrants.id, grantId)),
      APPLICATION_ROLE_GRANT_IMMUTABLE_MESSAGE,
    );

    // Control: the revocation stamp alone is admitted.
    await getDb()
      .update(applicationRoleGrants)
      .set({ revokedAt: new Date(), revokedByUserId: granter, revokeReason: 'Rotation ended' })
      .where(eq(applicationRoleGrants.id, grantId));

    await expectRefused(
      getDb()
        .update(applicationRoleGrants)
        .set({ revokedAt: null, revokedByUserId: null, revokeReason: null })
        .where(eq(applicationRoleGrants.id, grantId)),
      APPLICATION_ROLE_GRANT_IMMUTABLE_MESSAGE,
    );
    await expectRefused(
      getDb()
        .update(applicationRoleGrants)
        .set({ revokeReason: 'a different story' })
        .where(eq(applicationRoleGrants.id, grantId)),
      APPLICATION_ROLE_GRANT_IMMUTABLE_MESSAGE,
    );
    await expectRefused(
      getDb()
        .update(applicationRoleGrants)
        .set({ grantedByUserId: null })
        .where(eq(applicationRoleGrants.id, grantId)),
      APPLICATION_ROLE_GRANT_IMMUTABLE_MESSAGE,
    );
  });

  it('holds one live grant per person and key, and re-granting after a revoke is a new row', async () => {
    const { grantId, grantee, granter, permissionId } = await seedFixture();
    await expect(
      getDb()
        .insert(applicationRoleGrants)
        .values({ permissionId, userId: grantee, grantedByUserId: granter }),
    ).rejects.toThrow();
    await getDb()
      .update(applicationRoleGrants)
      .set({ revokedAt: new Date(), revokedByUserId: granter })
      .where(eq(applicationRoleGrants.id, grantId));
    await getDb()
      .insert(applicationRoleGrants)
      .values({ permissionId, userId: grantee, grantedByUserId: granter });
  });

  it('erasing the granter keeps the grant; erasing the grantee removes it', async () => {
    const { grantId, granter, grantee } = await seedFixture();
    await getDb().delete(users).where(eq(users.id, granter));
    const [kept] = await getDb()
      .select({ grantedByUserId: applicationRoleGrants.grantedByUserId })
      .from(applicationRoleGrants)
      .where(eq(applicationRoleGrants.id, grantId));
    expect(kept).toEqual({ grantedByUserId: null });

    await getDb().delete(users).where(eq(users.id, grantee));
    const gone = await getDb()
      .select({ id: applicationRoleGrants.id })
      .from(applicationRoleGrants)
      .where(eq(applicationRoleGrants.id, grantId));
    expect(gone).toEqual([]);
  });
});
