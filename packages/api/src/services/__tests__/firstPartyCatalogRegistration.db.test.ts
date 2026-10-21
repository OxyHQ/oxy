/**
 * Oxy registering the catalogue it ships (ADR 0048), against a real Postgres.
 *
 *  1. **A first-party registration has no credential, and says so.** The row's
 *     authority is `first_party`, never a credential; the database refuses a
 *     row that names both or neither.
 *  2. **A deploy over unchanged code is a no-op**, and a new version supersedes
 *     the old one in place: exactly one registration per app is ever active.
 *  3. **The namespace stays owned.** Another application cannot register over
 *     a catalogue it does not own, by either route.
 */

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { capabilityCatalogBindingSchema } from '@oxy.so/contracts';

import { oxyProfileCapabilityCatalog } from '../../capabilities/oxy-profile.catalog';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appCapabilityCatalogRegistrations } from '../../db/schema/agency';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import {
  activeCapabilityCatalog,
  digestCatalog,
  registerCapabilityCatalog,
  registerFirstPartyCapabilityCatalog,
} from '../capabilityCatalog.service';

const createdApplicationIds: string[] = [];
const keyPair = generateKeyPairSync('ed25519');
const originalKeyId = process.env.CAPABILITY_TICKET_SIGNING_KEY_ID;
const originalPrivateKey = process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY;

beforeAll(async () => {
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'first-party-catalog-test';
  process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = keyPair.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  await connectPostgres();
});

afterAll(async () => {
  if (originalKeyId === undefined)
    Reflect.deleteProperty(process.env, 'CAPABILITY_TICKET_SIGNING_KEY_ID');
  else process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = originalKeyId;
  if (originalPrivateKey === undefined)
    Reflect.deleteProperty(process.env, 'CAPABILITY_TICKET_SIGNING_PRIVATE_KEY');
  else process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = originalPrivateKey;
  for (const id of createdApplicationIds) {
    await getDb().delete(applications).where(eq(applications.id, id));
  }
  await closePostgres();
});

const slug = () => `test-${randomBytes(6).toString('hex')}`;

/** The real Oxy catalogue, moved into a namespace of its own so tests never touch `oxy`. */
const catalogIn = (appId: string, version = '1.0.0') => ({
  ...oxyProfileCapabilityCatalog(),
  appId,
  version,
});

async function application() {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `First-party catalog test ${randomUUID()}`,
      ownerAccountId: owner.id,
      status: 'active',
      isOfficial: true,
      scopes: ['user:read', 'catalogs:write'],
    })
    .returning({ id: applications.id });
  createdApplicationIds.push(row.id);
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      name: 'First-party catalog test credential',
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

describe('registerFirstPartyCapabilityCatalog', () => {
  it('registers the catalogue with no credential and a binding an app can pin', async () => {
    const owner = await application();
    const appId = slug();
    const registration = await registerFirstPartyCapabilityCatalog({
      catalog: catalogIn(appId),
      applicationId: owner.id,
    });

    expect(registration).toMatchObject({
      appSlug: appId,
      source: 'first_party',
      registeredByApplicationId: owner.id,
      registeredByCredentialId: null,
      active: true,
      digest: digestCatalog(catalogIn(appId)),
    });
    expect(
      capabilityCatalogBindingSchema.parse({
        registrationId: registration.id,
        version: registration.version,
        digest: registration.digest,
      }),
    ).toBeTruthy();
  });

  it('is a no-op over unchanged code', async () => {
    const owner = await application();
    const appId = slug();
    const first = await registerFirstPartyCapabilityCatalog({
      catalog: catalogIn(appId),
      applicationId: owner.id,
    });
    const second = await registerFirstPartyCapabilityCatalog({
      catalog: catalogIn(appId),
      applicationId: owner.id,
    });

    expect(second.id).toBe(first.id);
    const rows = await getDb()
      .select()
      .from(appCapabilityCatalogRegistrations)
      .where(eq(appCapabilityCatalogRegistrations.appSlug, appId));
    expect(rows).toHaveLength(1);
  });

  it('supersedes the previous version, leaving exactly one active', async () => {
    const owner = await application();
    const appId = slug();
    await registerFirstPartyCapabilityCatalog({
      catalog: catalogIn(appId, '1.0.0'),
      applicationId: owner.id,
    });
    const next = await registerFirstPartyCapabilityCatalog({
      catalog: catalogIn(appId, '1.1.0'),
      applicationId: owner.id,
    });

    expect((await activeCapabilityCatalog(appId))?.id).toBe(next.id);
    const active = await getDb()
      .select({ version: appCapabilityCatalogRegistrations.version })
      .from(appCapabilityCatalogRegistrations)
      .where(
        and(
          eq(appCapabilityCatalogRegistrations.appSlug, appId),
          eq(appCapabilityCatalogRegistrations.active, true),
        ),
      );
    expect(active).toEqual([{ version: '1.1.0' }]);
  });

  it('refuses a namespace another application owns, by either route', async () => {
    const owner = await application();
    const other = await application();
    const appId = slug();
    await registerFirstPartyCapabilityCatalog({
      catalog: catalogIn(appId),
      applicationId: owner.id,
    });

    await expect(
      registerFirstPartyCapabilityCatalog({
        catalog: catalogIn(appId, '1.1.0'),
        applicationId: other.id,
      }),
    ).rejects.toThrow('already owned by another application');
    await expect(
      registerCapabilityCatalog({
        catalog: catalogIn(appId, '1.1.0'),
        applicationId: other.id,
        credentialId: other.credentialId,
      }),
    ).rejects.toThrow('already owned by another application');
  });

  it('keeps registering through a credential as before', async () => {
    const owner = await application();
    const appId = slug();
    const registration = await registerCapabilityCatalog({
      catalog: catalogIn(appId),
      applicationId: owner.id,
      credentialId: owner.credentialId,
    });

    expect(registration).toMatchObject({
      source: 'credential',
      registeredByCredentialId: owner.credentialId,
    });
  });
});

describe('app_capability_catalog_registrations authority', () => {
  const insert = (values: {
    source: string;
    applicationId: string;
    credentialId: string | null;
  }) => {
    const catalog = catalogIn(slug());
    return getDb()
      .insert(appCapabilityCatalogRegistrations)
      .values({
        appSlug: catalog.appId,
        version: catalog.version,
        audience: catalog.audience,
        catalog,
        digest: digestCatalog(catalog),
        signature: 'test',
        source: values.source,
        registeredByApplicationId: values.applicationId,
        registeredByCredentialId: values.credentialId,
        deployedAt: new Date(),
      });
  };

  it('refuses a credential registration with no credential', async () => {
    const owner = await application();
    await expect(
      insert({ source: 'credential', applicationId: owner.id, credentialId: null }),
    ).rejects.toThrow();
  });

  it('refuses a first-party registration that also names a credential', async () => {
    const owner = await application();
    await expect(
      insert({ source: 'first_party', applicationId: owner.id, credentialId: owner.credentialId }),
    ).rejects.toThrow();
  });

  it('refuses an unknown authority', async () => {
    const owner = await application();
    await expect(
      insert({ source: 'operator', applicationId: owner.id, credentialId: null }),
    ).rejects.toThrow();
  });
});
