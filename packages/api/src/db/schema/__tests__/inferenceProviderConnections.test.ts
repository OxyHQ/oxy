import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { inferenceProviderConnections } from '../inferenceProviderConnections';
import { inferenceProviders } from '../inferenceProviders';
import { users } from '../users';
import { MIGRATIONS_FOLDER } from '../../migrationsFolder';

beforeAll(connectPostgres);
afterAll(closePostgres);

function tag(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

async function baseValues(overrides: Record<string, unknown> = {}) {
  const idTag = tag();
  const [account] = await getDb()
    .insert(users)
    .values({ username: `kcs-${idTag}`, email: `kcs-${idTag}@example.test` })
    .returning({ id: users.id });
  const provider = `kcsp${idTag}`;
  await getDb().insert(inferenceProviders).values({
    slug: provider,
    displayName: 'Custody Schema Fixture',
    kind: 'customer_byok',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });
  return {
    id: uuidv7(),
    provider,
    ownerAccountId: account.id,
    scopeKind: 'account' as const,
    applicationId: null,
    environment: 'production' as const,
    status: 'pending_validation' as const,
    custodyState: 'ready' as const,
    credentialHandle: `kcred_${'a'.repeat(16)}${idTag.replace(/[0189]/g, 'a')}`,
    credentialRevision: 1,
    keyPrefix: 'sk-fixture',
    fingerprint: 'a'.repeat(64),
    validationState: 'unvalidated' as const,
    ...overrides,
  };
}

async function expectCheck(values: Awaited<ReturnType<typeof baseValues>>, name: string) {
  await expect(getDb().insert(inferenceProviderConnections).values(values)).rejects.toMatchObject({
    cause: expect.objectContaining({ code: '23514', constraint_name: name }),
  });
}

describe('inference_provider_connections Kaana custody constraints', () => {
  it('applies the real post migration and leaves no legacy secret_ref column', async () => {
    const columns = await getDb().execute<{ column_name: string }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'inference_provider_connections'
        and column_name = 'secret_ref'
    `);
    expect(columns).toHaveLength(0);

    const post = readFileSync(
      join(MIGRATIONS_FOLDER, '0066_drop_legacy_provider_secret_ref.sql'),
      'utf8',
    );
    expect(post).toContain('-- oxy:deploy-phase=post');
    expect(post).toContain('DROP COLUMN "secret_ref"');
  });

  it('proves the pre-migration inventory guard fails closed on a real PostgreSQL row', async () => {
    await getDb()
      .insert(inferenceProviderConnections)
      .values(await baseValues());
    const pre = readFileSync(join(MIGRATIONS_FOLDER, '0065_kaana_credential_custody.sql'), 'utf8');
    const inventoryGuard = pre.split('--> statement-breakpoint', 1)[0];
    await expect(getDb().execute(sql.raw(inventoryGuard))).rejects.toThrow(
      /requires an empty legacy provider-connection inventory/,
    );
  });

  it('stores an opaque handle and exact positive revision', async () => {
    const values = await baseValues();
    const [row] = await getDb().insert(inferenceProviderConnections).values(values).returning();
    expect(row).toMatchObject({
      credentialHandle: values.credentialHandle,
      credentialRevision: 1,
      custodyState: 'ready',
    });
  });

  it('refuses locators and credential-shaped strings as handles', async () => {
    for (const credentialHandle of [
      'vault:oxy/inference/byok/production/account/connection',
      'ssm:/customer/key',
      'customer-provider-key',
    ]) {
      await expectCheck(
        await baseValues({ credentialHandle }),
        'inference_provider_connections_credential_handle_format',
      );
    }
  });

  it('requires handle and revision as one pair', async () => {
    await expectCheck(
      await baseValues({ credentialRevision: null }),
      'inference_provider_connections_credential_reference_pair',
    );
    await expectCheck(
      await baseValues({ credentialHandle: null }),
      'inference_provider_connections_credential_reference_pair',
    );
  });

  it('requires a positive revision and references for ready/revoked', async () => {
    await expectCheck(
      await baseValues({ credentialRevision: 0 }),
      'inference_provider_connections_credential_revision_positive',
    );
    await expectCheck(
      await baseValues({ credentialHandle: null, credentialRevision: null }),
      'inference_provider_connections_custody_reference_required',
    );
  });

  it('admits pending only before Kaana returns a reference', async () => {
    const pending = await baseValues({
      custodyState: 'pending',
      credentialHandle: null,
      credentialRevision: null,
    });
    await expect(
      getDb().insert(inferenceProviderConnections).values(pending),
    ).resolves.toBeDefined();
    await expectCheck(
      await baseValues({ custodyState: 'pending' }),
      'inference_provider_connections_pending_has_no_reference',
    );
  });

  it('prevents one Kaana handle from authorizing two connections', async () => {
    const first = await baseValues();
    await getDb().insert(inferenceProviderConnections).values(first);
    const second = await baseValues({
      credentialHandle: first.credentialHandle,
    });
    await expect(getDb().insert(inferenceProviderConnections).values(second)).rejects.toMatchObject(
      {
        cause: expect.objectContaining({
          code: '23505',
          constraint_name: 'inference_provider_connections_credential_handle_key',
        }),
      },
    );
  });
});
