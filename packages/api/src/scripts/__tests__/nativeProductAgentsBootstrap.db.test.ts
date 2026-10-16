import { insertAccountFixture } from '../../db/__fixtures__/accountIdentity';
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
 *
 * It owns a fully migrated database of its own, as
 * `routes/__tests__/nativeRequesterAssertion.routes.test.ts` does: the reserved
 * Oxy organisation and Homiio application carry real authority, and other
 * suites in a worker's shared database create (and hang usage rows off) the
 * same organisation, so seeding or deleting it there would race them.
 */

import { spawnSync } from 'node:child_process';
import { and, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { NATIVE_PRODUCT_AGENTS } from '../../config/nativeProductAgents';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { securityActivities } from '../../db/schema/securityActivities';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';

const ORG = NATIVE_PRODUCT_AGENTS.oxyOrganizationId;
const { homiio, clarity } = NATIVE_PRODUCT_AGENTS.products;
const SINDI = homiio.sindiServiceCredential;
const ROLE = homiio.workload.subject;
const STORED_SECRET_HASH = 'c'.repeat(64);
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
let ownDatabaseUrl: string | undefined;

jest.setTimeout(120_000);

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
  ownDatabaseUrl = await createTestDatabase();
  await connectPostgres();
  // The production shape the bootstrap was first applied over: the reserved
  // organisation, the pre-existing Homiio application, and a LIVE Sindi
  // credential whose secret lived in SSM. Clarity is left entirely absent, the
  // fresh-environment case.
  await insertAccountFixture({ id: ORG, kind: 'organization', accountStatus: 'active' });
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
      capabilities: ['existing-capability'],
    });
  await getDb()
    .insert(applicationWorkloadIdentities)
    .values({
      applicationId: homiio.applicationId,
      ...homiio.organizationImport.workerWorkload,
      scopes: ['user:read'],
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
  try {
    await closePostgres();
  } finally {
    try {
      if (ownDatabaseUrl) await dropTestDatabase(ownDatabaseUrl);
    } finally {
      if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    }
  }
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
      plan: expect.objectContaining({
        desired: expect.any(Object),
        before: expect.any(Object),
        after: expect.any(Object),
        operations: expect.any(Array),
      }),
    });
    const safeReport = spawnSync(
      'bun',
      ['scripts/validate-native-product-bootstrap-report.mjs', '--check'],
      {
        cwd: `${__dirname}/../../..`,
        input: `NATIVE_PRODUCT_AGENTS_RESULT=${JSON.stringify(dry.result)}`,
        encoding: 'utf8',
      },
    );
    expect(safeReport.status).toBe(0);
    expect(JSON.stringify(dry.result)).not.toContain(STORED_SECRET_HASH);
    expect(JSON.stringify(dry.result)).not.toContain('secretHash');
    expect((await sindiCredential()).status).toBe('active');
    const [beforeApp] = await getDb()
      .select()
      .from(applications)
      .where(eq(applications.id, homiio.applicationId));
    expect(beforeApp.scopes).not.toContain(homiio.organizationImport.scope);
    expect(beforeApp.capabilities).toEqual(['existing-capability']);

    const apply = runBootstrap({
      APPLY: '1',
      BOOTSTRAP_ACTOR: 'native-agent-db-test',
      BOOTSTRAP_REASON: 'retire the Sindi key pair',
      EXPECTED_PLAN_SHA256: String(dry.result?.planSha256),
    });
    expect(apply).toEqual({
      status: 0,
      result: {
        mode: 'apply',
        direction: 'bootstrap',
        planSha256: dry.result?.planSha256,
        plan: dry.result?.plan,
      },
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
    const [backend] = await getDb()
      .select({ webhookUrl: applications.webhookUrl, scopes: applications.scopes })
      .from(applications)
      .where(eq(applications.id, clarity.backendApplication.id));
    expect(backend.webhookUrl).toBe(clarity.backendApplication.webhookUrl);
    // A fresh backend is created holding the reviewed file grant (ADR 0041).
    expect(backend.scopes).toEqual([
      ...clarity.backendApplication.scopes,
      ...clarity.backendApplication.fileScopes,
    ]);
    const [importer] = await getDb()
      .select()
      .from(applications)
      .where(eq(applications.id, homiio.applicationId));
    expect(importer.scopes).toEqual(
      expect.arrayContaining(['user:read', ...SINDI.scopes, homiio.organizationImport.scope]),
    );
    expect(importer.capabilities).toEqual([
      'existing-capability',
      homiio.organizationImport.capability,
    ]);
    const [binding] = await getDb()
      .select()
      .from(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, ROLE));
    expect(binding.scopes).toEqual([...SINDI.scopes]);
    const [workerBinding] = await getDb()
      .select()
      .from(applicationWorkloadIdentities)
      .where(
        eq(applicationWorkloadIdentities.subject, homiio.organizationImport.workerWorkload.subject),
      );
    expect(workerBinding.scopes).toEqual(['user:read', homiio.organizationImport.scope]);

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

  it('leaves retired credentials alone when the API binding is absent but the importer worker remains live', async () => {
    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, ROLE));
    const rerun = runBootstrap();
    expect(rerun.status).toBe(0);
    expect(rerun.result).toMatchObject({ mode: 'dry-run', direction: 'bootstrap' });
    expect((await sindiCredential()).status).toBe('revoked');
    await bindHomiio(SINDI.scopes);
  });
  it('applies an already provisioned import grant idempotently and refuses stale reviewed plans', async () => {
    const dry = runBootstrap();
    expect(dry.status).toBe(0);
    await getDb()
      .update(applications)
      .set({
        capabilities: [
          'existing-capability',
          homiio.organizationImport.capability,
          'new-preserved-capability',
        ],
      })
      .where(eq(applications.id, homiio.applicationId));
    const stale = runBootstrap({
      APPLY: '1',
      BOOTSTRAP_ACTOR: 'native-agent-db-test',
      BOOTSTRAP_REASON: 'review importer scope',
      EXPECTED_PLAN_SHA256: String(dry.result?.planSha256),
    });
    expect(stale.status).toBe(1);
    const fresh = runBootstrap();
    expect(fresh.result?.planSha256).not.toBe(dry.result?.planSha256);
    const applied = runBootstrap({
      APPLY: '1',
      BOOTSTRAP_ACTOR: 'native-agent-db-test',
      BOOTSTRAP_REASON: 'review importer scope',
      EXPECTED_PLAN_SHA256: String(fresh.result?.planSha256),
    });
    expect(applied.status).toBe(0);
    const [app] = await getDb()
      .select()
      .from(applications)
      .where(eq(applications.id, homiio.applicationId));
    expect(app.capabilities).toEqual([
      'existing-capability',
      homiio.organizationImport.capability,
      'new-preserved-capability',
    ]);
    expect(app.scopes.filter((scope) => scope === homiio.organizationImport.scope)).toHaveLength(1);
  });
  it('refuses import provisioning when the worker binding is expired', async () => {
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ expiresAt: new Date(0) })
      .where(
        eq(applicationWorkloadIdentities.subject, homiio.organizationImport.workerWorkload.subject),
      );
    try {
      expect(runBootstrap().result).toMatchObject({
        code: 'live_state_drift',
        target: 'homiio_workload_binding',
      });
    } finally {
      await getDb()
        .update(applicationWorkloadIdentities)
        .set({ expiresAt: null })
        .where(
          eq(
            applicationWorkloadIdentities.subject,
            homiio.organizationImport.workerWorkload.subject,
          ),
        );
    }
  });
  it('widens an existing Clarity backend and its live binding by exactly the file grant (ADR 0041)', async () => {
    const BASE = [...clarity.backendApplication.scopes];
    await getDb()
      .update(applications)
      .set({ scopes: BASE })
      .where(eq(applications.id, clarity.backendApplication.id));
    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, clarity.workload.subject));
    const [binding] = await getDb()
      .insert(applicationWorkloadIdentities)
      .values({
        applicationId: clarity.backendApplication.id,
        provider: 'aws-iam',
        subject: clarity.workload.subject,
        scopes: BASE,
      })
      .returning({ id: applicationWorkloadIdentities.id });
    try {
      const dry = runBootstrap();
      expect(dry.status).toBe(0);
      const operations =
        (dry.result?.plan as { operations: string[] } | undefined)?.operations ?? [];
      for (const scope of clarity.backendApplication.fileScopes) {
        expect(operations).toContain(
          `grant application-scope ${clarity.backendApplication.id}:${scope}`,
        );
        expect(operations).toContain(`grant workload-scope ${binding.id}:${scope}`);
      }
      const applied = runBootstrap({
        APPLY: '1',
        BOOTSTRAP_ACTOR: 'native-agent-db-test',
        BOOTSTRAP_REASON: 'grant Clarity its file scopes',
        EXPECTED_PLAN_SHA256: String(dry.result?.planSha256),
      });
      expect(applied.status).toBe(0);
      const [app] = await getDb()
        .select({ scopes: applications.scopes })
        .from(applications)
        .where(eq(applications.id, clarity.backendApplication.id));
      expect(app.scopes).toEqual([...BASE, ...clarity.backendApplication.fileScopes]);
      const [bound] = await getDb()
        .select({ scopes: applicationWorkloadIdentities.scopes })
        .from(applicationWorkloadIdentities)
        .where(eq(applicationWorkloadIdentities.id, binding.id));
      expect(bound.scopes).toEqual([...BASE, ...clarity.backendApplication.fileScopes]);

      // Idempotent: the next run only asserts.
      const again = runBootstrap();
      const againOperations =
        (again.result?.plan as { operations: string[] } | undefined)?.operations ?? [];
      expect(
        againOperations.some((operation) => operation.includes('grant application-scope')),
      ).toBe(false);
      expect(againOperations).toContain(`assert workload-scope ${binding.id}:files:app:write`);
    } finally {
      await getDb()
        .delete(applicationWorkloadIdentities)
        .where(eq(applicationWorkloadIdentities.id, binding.id));
    }
  });
  it('still refuses any OTHER scope on the Clarity backend as drift', async () => {
    const [before] = await getDb()
      .select({ scopes: applications.scopes })
      .from(applications)
      .where(eq(applications.id, clarity.backendApplication.id));
    await getDb()
      .update(applications)
      .set({ scopes: [...before.scopes, 'files:write'] })
      .where(eq(applications.id, clarity.backendApplication.id));
    try {
      expect(runBootstrap().result).toMatchObject({
        code: 'live_state_drift',
        target: 'clarity_backend_application',
      });
    } finally {
      await getDb()
        .update(applications)
        .set({ scopes: before.scopes })
        .where(eq(applications.id, clarity.backendApplication.id));
    }
  });
  it('refuses to replace an unrelated existing Clarity webhook', async () => {
    await getDb()
      .update(applications)
      .set({ webhookUrl: 'https://example.test/existing' })
      .where(eq(applications.id, clarity.backendApplication.id));
    try {
      expect(runBootstrap().status).toBe(1);
      const [app] = await getDb()
        .select({ webhookUrl: applications.webhookUrl })
        .from(applications)
        .where(eq(applications.id, clarity.backendApplication.id));
      expect(app.webhookUrl).toBe('https://example.test/existing');
    } finally {
      await getDb()
        .update(applications)
        .set({ webhookUrl: clarity.backendApplication.webhookUrl })
        .where(eq(applications.id, clarity.backendApplication.id));
    }
  });
});
