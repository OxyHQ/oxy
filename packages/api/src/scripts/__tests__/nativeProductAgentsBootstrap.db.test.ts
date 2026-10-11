/**
 * The native product-agent bootstrap, run for real against PostgreSQL.
 *
 * What is under test is the retirement of the two service credentials the
 * bootstrap used to mint (ADR 0025's 2026-10-11 amendment): the process holds
 * no secret, never creates either credential, and revokes a live one only once
 * the workload replacing it is bound live with every scope it carried. That is
 * a property of the script's real queries and transaction — a mocked database
 * would accept a revocation the ordering forbids — so the script runs as the
 * one-shot task runs it: a separate `bun` process, `DATABASE_URL` and the
 * approval variables in its environment, and nothing else.
 */

import { spawnSync } from 'node:child_process';
import { and, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { NATIVE_PRODUCT_AGENTS } from '../../config/nativeProductAgents';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { internalCostCenters } from '../../db/schema/internalCostCenters';
import { securityActivities } from '../../db/schema/securityActivities';
import { users } from '../../db/schema/users';

const ORG = NATIVE_PRODUCT_AGENTS.oxyOrganizationId;
const { homiio, clarity } = NATIVE_PRODUCT_AGENTS.products;
const SINDI = homiio.sindiServiceCredential;
const ROLE = homiio.workload.subject;
const STORED_SECRET_HASH = 'c'.repeat(64);

interface BootstrapRun {
  readonly status: number | null;
  readonly result: Record<string, unknown> | null;
}

function runBootstrap(env: Record<string, string> = {}): BootstrapRun {
  const child = spawnSync('bun', ['run', 'scripts/bootstrap-native-product-agents.ts'], {
    cwd: `${__dirname}/../../..`,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ...env,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const line = child.stdout
    .split('\n')
    .find((candidate) => candidate.startsWith('NATIVE_PRODUCT_AGENTS_RESULT='));
  return {
    status: child.status,
    result: line ? JSON.parse(line.slice('NATIVE_PRODUCT_AGENTS_RESULT='.length)) : null,
  };
}

async function sindiCredential() {
  const [row] = await getDb()
    .select({
      status: applicationCredentials.status,
      secretHash: applicationCredentials.secretHash,
    })
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, SINDI.id));
  return row;
}

async function bindHomiio(scopes: readonly string[]): Promise<void> {
  await getDb()
    .delete(applicationWorkloadIdentities)
    .where(eq(applicationWorkloadIdentities.subject, ROLE));
  await getDb()
    .insert(applicationWorkloadIdentities)
    .values({
      applicationId: homiio.applicationId,
      provider: 'aws-iam',
      subject: ROLE,
      scopes: [...scopes],
    });
}

beforeAll(async () => {
  await connectPostgres();
  // The production shape the bootstrap was first applied over: the reserved
  // organisation, the pre-existing Homiio application, and a LIVE Sindi
  // credential whose secret lived in SSM. Clarity is left entirely absent, the
  // fresh-environment case.
  await getDb().insert(users).values({ id: ORG, kind: 'organization', accountStatus: 'active' });
  await getDb()
    .insert(applications)
    .values({
      id: homiio.applicationId,
      name: `Homiio native-agent fixture ${homiio.applicationId}`,
      type: 'first_party',
      status: 'active',
      isOfficial: true,
      isInternal: false,
      ownerAccountId: ORG,
      scopes: ['user:read', ...SINDI.scopes],
    });
  await getDb()
    .insert(applicationCredentials)
    .values({
      id: SINDI.id,
      applicationId: homiio.applicationId,
      name: 'Sindi production service',
      publicKey: SINDI.clientId,
      secretHash: STORED_SECRET_HASH,
      type: 'service',
      environment: 'production',
      scopes: [...SINDI.scopes],
      status: 'active',
      createdByUserId: ORG,
    });
});

afterAll(async () => {
  const db = getDb();
  const applicationIds = [
    homiio.applicationId,
    clarity.application.id,
    clarity.backendApplication.id,
  ];
  const accountIds = [homiio.bot.id, clarity.bot.id, homiio.project.id, clarity.project.id];
  await db.delete(securityActivities).where(eq(securityActivities.userId, ORG));
  await db
    .delete(applicationWorkloadIdentities)
    .where(inArray(applicationWorkloadIdentities.applicationId, applicationIds));
  await db
    .delete(applicationCredentials)
    .where(inArray(applicationCredentials.applicationId, applicationIds));
  await db.delete(applications).where(inArray(applications.id, applicationIds));
  await db
    .delete(internalCostCenters)
    .where(inArray(internalCostCenters.accountId, [homiio.project.id, clarity.project.id]));
  for (const id of [...accountIds, ORG]) await db.delete(users).where(eq(users.id, id));
  await closePostgres();
});

describe('bootstrap-native-product-agents.ts (no key pair)', () => {
  it('refuses to revoke the live Sindi credential while the Homiio workload is unbound', async () => {
    expect(runBootstrap()).toEqual({
      status: 1,
      result: {
        status: 'failed',
        code: 'live_state_drift',
        target: 'homiio_workload_binding',
        field: 'subject',
      },
    });
    expect(await sindiCredential()).toEqual({ status: 'active', secretHash: STORED_SECRET_HASH });
  });

  it('refuses while the binding lacks a scope the credential carried', async () => {
    await bindHomiio(['inference:invoke']);
    expect(runBootstrap().result).toEqual({
      status: 'failed',
      code: 'live_state_drift',
      target: 'homiio_workload_binding',
      field: 'scopes',
    });
    expect((await sindiCredential()).status).toBe('active');
  });

  it('dry-runs without writing, then revokes on the approved plan with no secret supplied', async () => {
    await bindHomiio(SINDI.scopes);

    const dry = runBootstrap();
    expect(dry.status).toBe(0);
    expect(dry.result).toEqual({
      mode: 'dry-run',
      direction: 'bootstrap',
      planSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await sindiCredential()).status).toBe('active');

    const apply = runBootstrap({
      APPLY: '1',
      BOOTSTRAP_ACTOR: 'native-agent-db-test',
      BOOTSTRAP_REASON: 'retire the Sindi key pair',
      EXPECTED_PLAN_SHA256: String(dry.result?.planSha256),
    });
    expect(apply).toEqual({
      status: 0,
      result: { mode: 'apply', direction: 'bootstrap', planSha256: dry.result?.planSha256 },
    });

    // Revoked, and only revoked: the row is the attribution of what it spent.
    expect(await sindiCredential()).toEqual({ status: 'revoked', secretHash: STORED_SECRET_HASH });
    // The Clarity backend credential was absent and stays absent; only the
    // keyless public client is created.
    const clarityCredentials = await getDb()
      .select({ id: applicationCredentials.id, secretHash: applicationCredentials.secretHash })
      .from(applicationCredentials)
      .where(
        inArray(applicationCredentials.applicationId, [
          clarity.application.id,
          clarity.backendApplication.id,
        ]),
      );
    expect(clarityCredentials).toEqual([{ id: clarity.publicCredential.id, secretHash: null }]);

    const [audit] = await getDb()
      .select({ metadata: securityActivities.metadata })
      .from(securityActivities)
      .where(and(eq(securityActivities.userId, ORG), eq(securityActivities.severity, 'high')));
    const operations = (audit?.metadata as { operations?: string[] } | undefined)?.operations;
    expect(operations).toContain(
      `revoke credential ${SINDI.id} superseded-by workload aws-iam:${ROLE}`,
    );
    expect(operations).toContain(`assert absent credential ${clarity.backendServiceCredential.id}`);
    expect(
      operations?.some((operation) => operation.startsWith(`insert credential ${SINDI.id}`)),
    ).toBe(false);
  });

  it('leaves a revoked credential alone without needing its binding any more', async () => {
    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, ROLE));
    const rerun = runBootstrap();
    expect(rerun.status).toBe(0);
    expect(rerun.result).toMatchObject({ mode: 'dry-run', direction: 'bootstrap' });
    expect((await sindiCredential()).status).toBe('revoked');
  });
});
