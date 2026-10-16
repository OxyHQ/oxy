/**
 * Moving a catalog namespace to the application that serves it now, against a
 * real Postgres. The failures worth testing are an operator's:
 *
 *  1. **The namespace must only go where it could have been registered.** A
 *     target without the staff-granted `catalog:<slug>`, or not active, is
 *     refused: the move must never hand a service tools it could not publish.
 *  2. **All of it moves.** Past registrations too, or `registerCapabilityCatalog`
 *     — which asks who owns ANY registration of the slug — still refuses the new
 *     owner, and the old one can still introspect tickets under it.
 *  3. **Re-running is safe**, and a dry run writes nothing.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appCapabilityCatalogRegistrations } from '../../db/schema/agency';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import {
  CatalogTransferError,
  parseTransferCatalogArgv,
  transferCapabilityCatalogOwnership,
} from '../capabilityCatalogTransfer.service';

const createdApplicationIds: string[] = [];

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  for (const id of createdApplicationIds) {
    await getDb().delete(applications).where(eq(applications.id, id));
  }
  await closePostgres();
});

const slug = () => `test-${randomBytes(6).toString('hex')}`;

async function application(overrides: Partial<typeof applications.$inferInsert> = {}) {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `Catalog transfer test ${randomUUID()}`,
      ownerAccountId: owner.id,
      status: 'active',
      isOfficial: true,
      scopes: ['user:read', 'catalogs:write'],
      ...overrides,
    })
    .returning({ id: applications.id });
  createdApplicationIds.push(row.id);
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      name: 'Catalog transfer test credential',
      applicationId: row.id,
      type: 'public',
      environment: 'production',
      status: 'active',
      publicKey: `test_public_${randomBytes(12).toString('hex')}`,
      scopes: ['user:read'],
    })
    .returning({ id: applicationCredentials.id });
  return { id: row.id, credentialId: credential.id };
}

/** A registration row, as `registerCapabilityCatalog` writes it. */
async function registration(
  appSlug: string,
  owner: { id: string; credentialId: string },
  version: string,
  active: boolean,
) {
  await getDb()
    .insert(appCapabilityCatalogRegistrations)
    .values({
      appSlug,
      version,
      audience: `oxy-${appSlug}-api`,
      catalog: { appId: appSlug, version } as never,
      digest: randomBytes(32).toString('hex'),
      signature: 'test-signature',
      registeredByApplicationId: owner.id,
      registeredByCredentialId: owner.credentialId,
      deployedAt: new Date(),
      active,
    });
}

async function ownersOf(appSlug: string): Promise<string[]> {
  const rows = await getDb()
    .select({ owner: appCapabilityCatalogRegistrations.registeredByApplicationId })
    .from(appCapabilityCatalogRegistrations)
    .where(eq(appCapabilityCatalogRegistrations.appSlug, appSlug));
  return [...new Set(rows.map((row) => row.owner))];
}

async function refusalOf(promise: Promise<unknown>): Promise<CatalogTransferError> {
  try {
    const value = await promise;
    throw new Error(`Expected a refusal, got ${JSON.stringify(value)}`);
  } catch (error: unknown) {
    if (error instanceof CatalogTransferError) return error;
    throw error;
  }
}

describe('transferCapabilityCatalogOwnership', () => {
  it('moves every registration of the namespace, and a re-run changes nothing', async () => {
    const appSlug = slug();
    const from = await application({ capabilities: [`catalog:${appSlug}`] });
    const to = await application({ capabilities: [`catalog:${appSlug}`] });
    await registration(appSlug, from, '1.0.0', false);
    await registration(appSlug, from, '1.1.0', true);

    const moved = await transferCapabilityCatalogOwnership({ appSlug, toApplicationId: to.id });
    expect(moved).toEqual({
      appSlug,
      toApplicationId: to.id,
      previousOwners: [from.id],
      moved: 2,
      outcome: 'transferred',
      dryRun: false,
    });
    expect(await ownersOf(appSlug)).toEqual([to.id]);

    const again = await transferCapabilityCatalogOwnership({ appSlug, toApplicationId: to.id });
    expect(again).toMatchObject({ moved: 0, outcome: 'unchanged', previousOwners: [to.id] });
  });

  it('writes nothing on a dry run', async () => {
    const appSlug = slug();
    const from = await application({ capabilities: [`catalog:${appSlug}`] });
    const to = await application({ capabilities: [`catalog:${appSlug}`] });
    await registration(appSlug, from, '1.0.0', true);

    const planned = await transferCapabilityCatalogOwnership({
      appSlug,
      toApplicationId: to.id,
      dryRun: true,
    });
    expect(planned).toMatchObject({ moved: 1, outcome: 'transferred', dryRun: true });
    expect(await ownersOf(appSlug)).toEqual([from.id]);
  });

  it('refuses a target without the namespace capability, or not active', async () => {
    const appSlug = slug();
    const from = await application({ capabilities: [`catalog:${appSlug}`] });
    await registration(appSlug, from, '1.0.0', true);

    const without = await application({ capabilities: ['catalog:something-else'] });
    expect(
      (
        await refusalOf(
          transferCapabilityCatalogOwnership({ appSlug, toApplicationId: without.id }),
        )
      ).reason,
    ).toBe('missing_catalog_capability');

    const suspended = await application({
      capabilities: [`catalog:${appSlug}`],
      status: 'suspended',
    });
    expect(
      (
        await refusalOf(
          transferCapabilityCatalogOwnership({ appSlug, toApplicationId: suspended.id }),
        )
      ).reason,
    ).toBe('inactive_application');

    expect(await ownersOf(appSlug)).toEqual([from.id]);
  });

  it('refuses a namespace nobody registered, and an application that does not exist', async () => {
    const appSlug = slug();
    const to = await application({ capabilities: [`catalog:${appSlug}`] });
    expect(
      (await refusalOf(transferCapabilityCatalogOwnership({ appSlug, toApplicationId: to.id })))
        .reason,
    ).toBe('unknown_catalog');
    expect(
      (
        await refusalOf(
          transferCapabilityCatalogOwnership({
            appSlug,
            toApplicationId: 'ffffffffffffffffffffffff',
          }),
        )
      ).reason,
    ).toBe('unknown_application');
  });
});

describe('parseTransferCatalogArgv', () => {
  it('reads the namespace, the target and a dry run, and refuses anything else', () => {
    expect(
      parseTransferCatalogArgv(['--app-id', 'noted', '--to-application-id=abc', '--dry-run']),
    ).toEqual({ appSlug: 'noted', toApplicationId: 'abc', dryRun: true });
    expect(() => parseTransferCatalogArgv(['--app-id', 'noted'])).toThrow('Usage');
    expect(() =>
      parseTransferCatalogArgv(['--app-id', 'Noted', '--to-application-id', 'abc']),
    ).toThrow('lowercase');
    expect(() => parseTransferCatalogArgv(['--force'])).toThrow('Unknown argument');
  });
});
