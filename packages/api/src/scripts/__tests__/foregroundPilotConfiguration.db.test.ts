/** Historical credential cleanup only, with real SQL and no workload provisioning. */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { applicationCredentialAuditEvents } from '../../db/schema/applicationCredentialAuditEvents';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';
import {
  type ForegroundPilotPlan,
  MENTION_BACKEND_ROLE,
  MENTION_MCP_ROLE,
  retireEphemeralRegistrarCredentials,
} from '../foregroundPilotConfiguration';
import { main } from '../foregroundPilotExecutor';
import {
  MENTION_APPLICATION_ID,
  OXY_PROFILE_REGISTRAR_APPLICATION_ID,
} from '../seedOxyApplicationsSpecs';
const originalDatabaseUrl = process.env.DATABASE_URL;
let ownDatabaseUrl: string | undefined;
jest.setTimeout(60_000);
beforeAll(async () => {
  ownDatabaseUrl = await createTestDatabase();
  await connectPostgres();
});
afterAll(async () => {
  try {
    await closePostgres();
  } finally {
    try {
      if (ownDatabaseUrl) await dropTestDatabase(ownDatabaseUrl);
    } finally {
      if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
});
beforeEach(async () => {
  await getDb()
    .delete(applications)
    .where(eq(applications.id, OXY_PROFILE_REGISTRAR_APPLICATION_ID));
});
async function fixture() {
  const [owner] = await insertAccountFixtures({ kind: 'organization' });
  await getDb().insert(applications).values({
    id: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
    name: 'Historical registrar',
    ownerAccountId: owner.id,
    type: 'first_party',
  });
  const nonce = randomBytes(16).toString('hex');
  const plan: ForegroundPilotPlan = {
    schemaVersion: 1,
    kind: 'i05-foreground-configuration',
    nonce,
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-01T00:30:00Z',
    expectedApplication: {
      id: MENTION_APPLICATION_ID,
      type: 'first_party',
      status: 'active',
      is_official: true,
      is_internal: false,
      owner_account_id: owner.id,
      scopes: ['user:read'],
      capabilities: [],
      row_revision: '1',
    },
    expectedWorkloads: [MENTION_BACKEND_ROLE, MENTION_MCP_ROLE].map((subject, index) => ({
      id: `historical-${index}`,
      application_id: MENTION_APPLICATION_ID,
      provider: 'aws-iam',
      subject,
      scopes: ['user:read'],
      expires_at: null,
      row_revision: '1',
    })),
    expectedCredentials: [0, 1].map((index) => ({
      id: `wl_historical-${index}`,
      application_id: MENTION_APPLICATION_ID,
      type: 'workload',
      environment: 'production',
      status: 'active',
      expires_at: null,
      scopes: [],
      workload_identity_id: `historical-${index}`,
      row_revision: '1',
    })),
    expectedOwners: [{ id: owner.id, account_status: 'active', row_revision: '1' }],
    registrarOwner: {
      id: owner.id,
      account_status: 'active',
      kind: 'organization',
      is_platform_root: true,
      row_revision: '1',
    },
    afterScopes: ['user:read', 'capability-tickets:issue'],
    afterCapabilities: ['agency:coordinate'],
    backendWorkloadId: 'historical-0',
    afterBackendScopes: ['user:read', 'capability-tickets:issue'],
  };
  const credential = async (name: string, scopes = ['catalogs:write']) => {
    const [row] = await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
        name,
        type: 'service',
        environment: 'production',
        status: 'active',
        publicKey: randomBytes(16).toString('hex'),
        secretHash: 'a'.repeat(64),
        scopes,
      })
      .returning();
    return row;
  };
  return { plan, credential };
}
it.each(['execute', 'rollback', 'register'])(
  'refuses retired %s before SQL or network',
  async (operation) => {
    await expect(main([operation, 'e30'])).rejects.toThrow('provisioning and rollback are retired');
  },
);
it('revokes only the exact historical nonce, idempotently after expiry, retaining audit history', async () => {
  const { plan, credential } = await fixture();
  const target = await credential(`I05 ephemeral registrar ${plan.nonce}`);
  const unrelated = await credential(`I05 ephemeral registrar ${'b'.repeat(32)}`);
  expect(await retireEphemeralRegistrarCredentials(plan)).toEqual({
    retainedCredentialIds: [target.id],
    allRevoked: true,
  });
  await retireEphemeralRegistrarCredentials(plan);
  const rows = await getDb()
    .select()
    .from(applicationCredentials)
    .where(eq(applicationCredentials.applicationId, OXY_PROFILE_REGISTRAR_APPLICATION_ID));
  expect(rows.find((row) => row.id === target.id)?.status).toBe('revoked');
  expect(rows.find((row) => row.id === unrelated.id)?.status).toBe('active');
  const audit = await getDb()
    .select()
    .from(applicationCredentialAuditEvents)
    .where(eq(applicationCredentialAuditEvents.credentialId, target.id));
  expect(audit.filter((row) => row.eventType === 'revoked')).toHaveLength(1);
});
it('refuses changed scope or owner and leaves the credential active', async () => {
  const { plan, credential } = await fixture();
  const target = await credential(`I05 ephemeral registrar ${plan.nonce}`, ['files:read']);
  await expect(retireEphemeralRegistrarCredentials(plan)).rejects.toThrow('cleanup scope');
  const [other] = await insertAccountFixtures({ kind: 'organization' });
  await getDb()
    .update(applications)
    .set({ ownerAccountId: other.id })
    .where(eq(applications.id, OXY_PROFILE_REGISTRAR_APPLICATION_ID));
  await expect(retireEphemeralRegistrarCredentials(plan)).rejects.toThrow('ownership changed');
  expect(
    (
      await getDb()
        .select()
        .from(applicationCredentials)
        .where(eq(applicationCredentials.id, target.id))
    )[0].status,
  ).toBe('active');
});
it('rejects widened historical receipt before revocation', async () => {
  const { plan, credential } = await fixture();
  const target = await credential(`I05 ephemeral registrar ${plan.nonce}`);
  await expect(
    retireEphemeralRegistrarCredentials({
      ...plan,
      afterBackendScopes: ['user:read', 'files:write'],
    }),
  ).rejects.toThrow('workload scope delta');
  expect(
    (
      await getDb()
        .select()
        .from(applicationCredentials)
        .where(eq(applicationCredentials.id, target.id))
    )[0].status,
  ).toBe('active');
});
