import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  applications,
  applicationCredentials,
  applicationWorkloadIdentities,
  accountClosureFences,
  users,
} from '../../db/schema';
import { seedOxyApplicationScopes, scopeSeedOptions } from '../seedOxyApplicationScopes';
import { MENTION_APPLICATION_ID, SEED_APPS } from '../seedOxyApplicationsSpecs';
import { MENTION_CLASSIFIER_IDENTITY } from '../../config/mentionClassifierEconomics';

const ownerId = '69b2d3df5d12f58c9800d651';
const appId = MENTION_APPLICATION_ID;
const spec = SEED_APPS.find((value) => value.id === appId);
if (!spec) throw new Error('Missing Mention specification');
const initialScopes = (spec.scopes ?? []).filter(
  (value) => !['inference:invoke', 'inference:usage:read'].includes(value),
);
const options = { onlyAppIds: appId, apply: false };
const dry = () => seedOxyApplicationScopes(options);
const apply = async () => {
  const p = await dry();
  return seedOxyApplicationScopes({
    ...options,
    apply: true,
    expectedPlanSha256: p.planSha256,
  });
};
async function app() {
  return (await getDb().select().from(applications).where(eq(applications.id, appId)))[0];
}
async function ownedRows() {
  return {
    applications: await getDb()
      .select()
      .from(applications)
      .where(eq(applications.createdByUserId, ownerId)),
    credentials: await getDb()
      .select()
      .from(applicationCredentials)
      .where(eq(applicationCredentials.applicationId, appId)),
    bindings: await getDb()
      .select()
      .from(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.applicationId, appId)),
  };
}
beforeAll(connectPostgres);
afterAll(closePostgres);
beforeEach(async () => {
  // The owner is the real `oxy` organization id, which other DB fixtures in
  // the same worker also create (the Alia revocation canary) and hang rows
  // off (usage receipts on their own applications). So this file never
  // deletes that account: it SETS the shape it needs, and clears only the
  // application row it owns.
  await getDb().delete(applications).where(eq(applications.id, appId));
  // A closure fence (installed by a test here, or by the canary) would
  // outlive the account now that the account is never deleted.
  await getDb().delete(accountClosureFences).where(eq(accountClosureFences.accountId, ownerId));
  const owner = {
    username: 'oxy',
    kind: 'organization',
    color: 'blue',
    type: 'local',
    accountStatus: 'active',
  } as const;
  await getDb()
    .insert(users)
    .values({ id: ownerId, ...owner })
    .onConflictDoUpdate({ target: users.id, set: owner });
  await getDb().insert(applications).values({
    id: appId,
    name: 'Mention',
    createdByUserId: ownerId,
    ownerAccountId: ownerId,
    type: 'first_party',
    isOfficial: true,
    isInternal: false,
    status: 'active',
    scopes: initialScopes,
    description: 'Preserve custom metadata',
    websiteUrl: 'https://synthetic.invalid/preserve',
    webhookUrl: 'https://synthetic.invalid/hook',
    webhookSecret: 'synthetic-preserve',
  });
  await getDb()
    .insert(applicationWorkloadIdentities)
    .values([
      {
        id: MENTION_CLASSIFIER_IDENTITY.bindingId,
        applicationId: appId,
        provider: 'aws-iam',
        subject: MENTION_CLASSIFIER_IDENTITY.subject,
        scopes: initialScopes,
      },
      {
        id: 'scope-seed-mcp',
        applicationId: appId,
        provider: 'aws-iam',
        subject: 'arn:aws:iam::237343248947:role/oxy-mention-mcp-synthetic',
        scopes: ['user:read'],
      },
    ]);
  await getDb().insert(applicationCredentials).values({
    id: MENTION_CLASSIFIER_IDENTITY.credentialId,
    applicationId: appId,
    name: 'Synthetic attribution',
    type: 'workload',
    environment: 'production',
    scopes: [],
    workloadIdentityId: MENTION_CLASSIFIER_IDENTITY.bindingId,
  });
});
afterEach(async () => {
  await getDb().delete(applications).where(eq(applications.id, appId));
});

describe('existing official application scopes-only seed', () => {
  it('dry-run changes zero rows; apply changes only scopes and preserves all metadata/credentials/bindings', async () => {
    const before = await ownedRows();
    const plan = await dry();
    expect(await ownedRows()).toEqual(before);
    expect(plan.applications[0].added).toEqual(['inference:invoke', 'inference:usage:read']);
    const receipt = await seedOxyApplicationScopes({
      ...options,
      apply: true,
      expectedPlanSha256: plan.planSha256,
    });
    const after = await ownedRows();
    expect(receipt.changed).toBe(1);
    expect(after.credentials).toEqual(before.credentials);
    expect(after.bindings).toEqual(before.bindings);
    expect({
      ...after.applications[0],
      scopes: before.applications[0].scopes,
    }).toEqual(before.applications[0]);
    expect(after.applications[0].isInternal).toBe(false);
    expect((await apply()).changed).toBe(0);
  });
  it('refuses a stale plan after concurrent scope amendment, preserving the amendment', async () => {
    const plan = await dry();
    await getDb()
      .update(applications)
      .set({ scopes: [...initialScopes, 'payments:read'] })
      .where(eq(applications.id, appId));
    const before = await app();
    await expect(
      seedOxyApplicationScopes({
        ...options,
        apply: true,
        expectedPlanSha256: plan.planSha256,
      }),
    ).rejects.toThrow('scope_seed_plan_changed');
    expect(await app()).toEqual(before);
  });
  it('refuses an empty non-target MCP binding expansion without touching any row', async () => {
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ scopes: [] })
      .where(eq(applicationWorkloadIdentities.id, 'scope-seed-mcp'));
    const before = await ownedRows();
    const plan = await dry();
    expect(plan.applyEligible).toBe(false);
    expect(plan.applications[0].nonTargetExpansions[0].id).toBe('scope-seed-mcp');
    await expect(
      seedOxyApplicationScopes({
        ...options,
        apply: true,
        expectedPlanSha256: plan.planSha256,
      }),
    ).rejects.toThrow('scope_seed_non_target_expansion');
    expect(await ownedRows()).toEqual(before);
  });
  it('rechecks binding expiry and current scopes in the plan hash', async () => {
    const plan = await dry();
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ expiresAt: new Date('2030-01-01T00:00:00Z') })
      .where(eq(applicationWorkloadIdentities.id, 'scope-seed-mcp'));
    await expect(
      seedOxyApplicationScopes({
        ...options,
        apply: true,
        expectedPlanSha256: plan.planSha256,
      }),
    ).rejects.toThrow('scope_seed_plan_changed');
    expect((await app()).scopes).toEqual(initialScopes);
  });
  it('refuses owner closure installed after dry run', async () => {
    const plan = await dry();
    await getDb().insert(accountClosureFences).values({ accountId: ownerId });
    await expect(
      seedOxyApplicationScopes({
        ...options,
        apply: true,
        expectedPlanSha256: plan.planSha256,
      }),
    ).rejects.toThrow('scope_seed_owner_fenced');
    expect((await app()).scopes).toEqual(initialScopes);
  });
  it.each(['name', 'isInternal', 'isOfficial', 'createdByUserId'] as const)(
    'refuses identity drift %s rather than repairing metadata',
    async (field) => {
      const value =
        field === 'name'
          ? 'Unrelated'
          : field === 'isInternal'
            ? true
            : field === 'isOfficial'
              ? false
              : null;
      await getDb()
        .update(applications)
        .set({ [field]: value })
        .where(eq(applications.id, appId));
      const before = await app();
      await expect(dry()).rejects.toThrow('scope_seed_application_identity_mismatch');
      expect(await app()).toEqual(before);
    },
  );
  it('refuses absent application; no app/client is created', async () => {
    await getDb().delete(applications).where(eq(applications.id, appId));
    await expect(dry()).rejects.toThrow('scope_seed_application_identity_mismatch');
    expect(await ownedRows()).toEqual({
      applications: [],
      bindings: [],
      credentials: [],
    });
  });
  it('validates every selected app before any update; a later missing app leaves Mention unchanged', async () => {
    const second = SEED_APPS.find((value) => value.id && value.id !== appId);
    if (!second?.id) throw new Error('fixture');
    await expect(
      seedOxyApplicationScopes({
        onlyAppIds: `${appId},${second.id}`,
        apply: true,
        expectedPlanSha256: '0'.repeat(64),
      }),
    ).rejects.toThrow();
    expect((await app()).scopes).toEqual(initialScopes);
  });
  it('keeps unrelated grant additions when constructing the union', async () => {
    await getDb()
      .update(applications)
      .set({ scopes: [...initialScopes, 'payments:read'] })
      .where(eq(applications.id, appId));
    await apply();
    expect((await app()).scopes).toContain('payments:read');
  });
  it('does not overwrite an amendment committed while apply waits for its app row lock', async () => {
    const plan = await dry();
    let release = () => {};
    let held = () => {};
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldPromise = new Promise<void>((resolve) => {
      held = resolve;
    });
    let lockPid = 0;
    const writer = getDb().transaction(async (tx) => {
      const [pid] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      lockPid = pid.pid;
      await tx.execute(sql`SELECT id FROM applications WHERE id=${appId} FOR UPDATE`);
      held();
      await releasePromise;
      await tx
        .update(applications)
        .set({ scopes: [...initialScopes, 'payments:read'] })
        .where(eq(applications.id, appId));
    });
    await heldPromise;
    const applying = seedOxyApplicationScopes({
      ...options,
      apply: true,
      expectedPlanSha256: plan.planSha256,
    }).then(
      () => false,
      () => true,
    );
    try {
      let waiting = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const [r] = await getDb().execute<{ waiting: boolean }>(
          sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${lockPid} = ANY(pg_blocking_pids(pid))) AS waiting`,
        );
        if (r.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await writer;
    }
    expect(await applying).toBe(true);
    expect((await app()).scopes).toEqual([...initialScopes, 'payments:read']);
  });
  it('refuses implicit expansion of a separate service credential', async () => {
    await getDb().insert(applicationCredentials).values({
      id: 'scope-seed-service',
      applicationId: appId,
      name: 'Synthetic service',
      type: 'service',
      environment: 'production',
      publicKey: 'scope-seed-public',
      secretHash: 'synthetic',
      scopes: [],
    });
    const plan = await dry();
    expect(plan.applyEligible).toBe(false);
    expect(plan.applications[0].nonTargetExpansions).toEqual([
      {
        kind: 'credential',
        id: 'scope-seed-service',
        added: ['inference:invoke', 'inference:usage:read'],
      },
    ]);
    const before = await ownedRows();
    await expect(
      seedOxyApplicationScopes({
        ...options,
        apply: true,
        expectedPlanSha256: plan.planSha256,
      }),
    ).rejects.toThrow('scope_seed_non_target_expansion');
    expect(await ownedRows()).toEqual(before);
  });
  it('fails closed on source wrapper input before connection', () => {
    for (const env of [
      {},
      { SCOPES_ONLY: 'true' },
      { SCOPES_ONLY: 'true', ONLY_APP_IDS: appId, ONLY_APPS: 'Mention' },
      { SCOPES_ONLY: 'true', ONLY_APP_IDS: appId },
    ])
      expect(() => scopeSeedOptions(env)).toThrow();
    expect(
      scopeSeedOptions({
        SCOPES_ONLY: 'true',
        ONLY_APP_IDS: appId,
        DRY_RUN: 'true',
      }),
    ).toEqual(options);
  });
});
