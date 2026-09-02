/**
 * A completed request that metered nothing, end to end (#972 §7.3).
 *
 * `services/__tests__/inferenceLedger.service.test.ts` covers the refusal at the
 * ledger: `settle` answers `zero-usage`, writes nothing, and leaves the hold
 * standing. What that cannot say is what the CUSTOMER gets, and that is the half
 * that matters for the bug: a provider omitting its usage block used to yield a
 * silently FREE 200. A refusal at the ledger that the edge then answered `200` to
 * would be the same bug with a tidier ledger.
 *
 * So this file asserts the whole path against a real Postgres, a real credential,
 * the real ledger and a fake data plane that reports `completed` with nothing
 * metered. In every case the customer gets an error rather than a free success,
 * and nothing is ever billed.
 *
 * ## Two halves, at two boundaries — and writing this test is what found the split
 *
 * The shapes are caught in different places, and the first draft of this file
 * assumed one place and was wrong:
 *
 *  - an **empty unit array** never reaches the ledger. The wire schema refuses
 *    `completed` with no units, so `validateCompletion` repudiates the whole
 *    answer and the request goes down the FAILURE path: a zero receipt, refund
 *    reason `usage_unavailable`, hold released immediately. That is the contracts
 *    half, and it was already in place.
 *  - **units present and all zero** pass that schema, because
 *    `usageQuantitySchema` allows `quantity: 0`. They reach `settle`, which
 *    refuses them with `zero-usage`, writes NOTHING, and leaves the hold for the
 *    expiry sweep. That is the api-side half, and it is what this change adds.
 *
 * Both are asserted, including the things that differ — whether a receipt exists,
 * whether the hold survives, and which of the two reasons is named. A change that
 * collapsed them would silently move one shape onto the other's path, and each
 * half is invisible in the other's test.
 *
 * **The control is the same fake reporting ONE token.** Without it, every
 * assertion here is also what a broken edge that refuses everything produces, and
 * "no receipt was written" is what a suite that never reserved anything reports.
 *
 * The edge needed no code change for the new status: both `settle` call sites
 * already route any non-`settled`/`already-settled` result into a loud branch, so
 * it arrives there by construction. That is precisely why this file exists — a
 * behaviour nobody wrote a line for is the kind that is never verified.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq } from 'drizzle-orm';
import type { InferenceRequest } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountBalances } from '../../db/schema/accountBalances';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import {
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
} from '../../db/schema';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { usageReceipts } from '../../db/schema/usageReceipts';
import { usageReservations } from '../../db/schema/usageReservations';
import { users } from '../../db/schema/users';
import { provisionBillingProfile, recordTopUp } from '../../services/inferenceLedger.service';
import type { KaanaClient, KaanaCompletion } from '../../services/kaanaClient';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { logger } from '../../utils/logger';
import { createInferenceEdgeRouter } from '../inferenceEdge';
import {
  createNeutralRoutingPolicy,
  insertValidRoutingScorecard,
} from '../__fixtures__/kaanaRuntimeFixtures';

const mockedLogger = logger as jest.Mocked<typeof logger>;

jest.setTimeout(60_000);

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
/* -------------------------------------------------------------------------- */

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

function json(response: RawResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

/** A server per test, so each can be given its own data plane. */
async function withServer(
  kaanaClient: KaanaClient,
  run: (
    request: (path: string, body: unknown, headers: Record<string, string>) => Promise<RawResponse>
  ) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/v1', createInferenceEdgeRouter({ kaanaClient }));

  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });

  const request = (
    path: string,
    body: unknown,
    headers: Record<string, string>
  ): Promise<RawResponse> => {
    const { port } = server.address() as AddressInfo;
    const payload = JSON.stringify(body);
    return new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
          );
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  };

  try {
    await run(request);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * The rollout flags this file runs with.
 *
 * All four default to the state that serves and charges nobody, so a refusal at
 * the audience gate would otherwise be indistinguishable from the settlement
 * refusal this file is about — both are non-200 with a request id. Their defaults
 * are asserted in `config/__tests__/rolloutFlags.test.ts`; nothing here is
 * evidence about them.
 */
const ROLLOUT_ENVIRONMENT = {
  INFERENCE_EDGE_AUDIENCE: 'public',
  INFERENCE_MACHINE_CREDENTIAL_AUTH: 'enabled',
  INFERENCE_CHARGING_AUTHORIZED: 'zero-usage-suite-fixture:2026-08-01',
  INFERENCE_PRIVACY_REVIEW: 'zero-usage-suite-fixture:2026-08-01',
} as const;

const ORIGINAL_ROLLOUT_ENVIRONMENT = Object.fromEntries(
  Object.keys(ROLLOUT_ENVIRONMENT).map((key) => [key, process.env[key]])
);

beforeAll(async () => {
  Object.assign(process.env, ROLLOUT_ENVIRONMENT);
  await connectPostgres();
});

afterAll(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ROLLOUT_ENVIRONMENT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  Fixture                                                                   */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly accountId: string;
  readonly token: string;
  readonly modelReference: string;
  readonly provider: string;
}

/** One funded account with one priced, approved route and an active machine key. */
async function makeFixture(): Promise<Fixture> {
  const db = getDb();
  const tag = randomUUID().replace(/-/g, '').slice(0, 10);

  const [account] = await db
    .insert(users)
    .values({ username: `zu-${tag}`, email: `zu-${tag}@example.test` })
    .returning({ id: users.id });

  const scopes = ['inference:invoke'];
  const [application] = await db
    .insert(applications)
    .values({ name: `ZeroUsage ${tag}`, ownerAccountId: account.id, scopes })
    .returning({ id: applications.id });

  const minted = generateMachineCredentialToken();
  await db.insert(applicationCredentials).values({
    applicationId: application.id,
    name: `key-${tag}`,
    publicKey: `oxy_dk_${tag}`,
    tokenPrefix: minted.tokenPrefix,
    tokenHash: minted.tokenHash,
    type: 'machine',
    environment: 'development',
    scopes,
    status: 'active',
  });

  const publisherSlug = `pub${tag}`;
  const modelSlug = `model-${tag}`;
  const providerSlug = `prov${tag}`;
  const kaanaDeploymentId = `kaana-zero-${tag}`;
  const revision = '2026-01-01';

  await db
    .insert(inferencePublishers)
    .values({ slug: publisherSlug, displayName: `Publisher ${tag}` });

  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: modelSlug,
      displayName: `Model ${tag}`,
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: false,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: false,
      supportsJsonMode: false,
      supportsReasoning: false,
      supportsStreaming: true,
      supportsPromptCaching: false,
      maxContextTokens: 200_000,
      maxOutputTokens: 8192,
      licenseId: 'apache-2.0',
      licenseDisplayName: 'Apache 2.0',
      commercialUseAllowed: true,
      requiresAttribution: false,
      releaseKind: 'open_weight',
    })
    .returning({ id: inferenceModels.id });

  const [revisionRow] = await db
    .insert(inferenceModelRevisions)
    .values({ modelId: model.id, revision, releasedAt: new Date(), isCurrent: true })
    .returning({ id: inferenceModelRevisions.id });

  await db.insert(inferenceProviders).values({
    slug: providerSlug,
    displayName: `Provider ${tag}`,
    kind: 'third_party',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });

  const [priceVersion] = await db
    .insert(priceVersions)
    .values({
      modelReference: `${publisherSlug}/${modelSlug}@${revision}`,
      provider: providerSlug,
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });

  await db.insert(priceVersionUnitPrices).values([
    { priceVersionId: priceVersion.id, unit: 'requests', amount: '0.000000000000', per: 1 },
    { priceVersionId: priceVersion.id, unit: 'input_tokens', amount: '3.000000000000', per: 1_000_000 },
    { priceVersionId: priceVersion.id, unit: 'cached_input_tokens', amount: '3.000000000000', per: 1_000_000 },
    { priceVersionId: priceVersion.id, unit: 'output_tokens', amount: '15.000000000000', per: 1_000_000 },
    { priceVersionId: priceVersion.id, unit: 'reasoning_tokens', amount: '15.000000000000', per: 1_000_000 },
  ]);

  await db.insert(inferenceDeployments).values({
    modelRevisionId: revisionRow.id,
    providerSlug,
    internalRouteId: kaanaDeploymentId,
    regions: ['us-west-2'],
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
    availabilityScope: 'public_payg',
    commercialPermission: 'public_resale_approved',
    status: 'active',
    legalReviewStatus: 'approved',
    legalReviewedAt: new Date(),
    legalReviewEvidenceRef: `contract-register/${tag}`,
    permissionState: 'approved',
    priceVersionId: priceVersion.id,
  });
  await insertValidRoutingScorecard({
    deploymentId: kaanaDeploymentId,
    priceVersionId: priceVersion.id,
    changedByUserId: account.id,
  });
  await createNeutralRoutingPolicy({
    accountId: account.id,
    applicationId: application.id,
  });

  await provisionBillingProfile({ accountId: account.id });
  await recordTopUp({
    idempotencyKey: `zu-top-up-${tag}`,
    accountId: account.id,
    currency: 'USD',
    amount: '10.000000000000',
    actor: { kind: 'machine' },
  });

  return {
    accountId: account.id,
    token: minted.token,
    modelReference: `${publisherSlug}/${modelSlug}`,
    provider: providerSlug,
  };
}

/**
 * A fake data plane reporting `completed` with exactly the units it is given.
 *
 * `units` is passed through verbatim, INCLUDING an empty array, because the shape
 * under test is one the wire schema admits and this file must be able to produce
 * it. TESTS ONLY — `services/kaanaClient.ts` has no production implementation.
 */
function kaanaReporting(
  units: readonly { unit: 'input_tokens' | 'output_tokens'; quantity: number }[],
  provider: string,
  seen: InferenceRequest[]
): KaanaClient {
  return {
    execute: async (envelope): Promise<KaanaCompletion> => {
      seen.push(envelope);
      const servedRoute = envelope.authorizedRoutes.find((route) => route.provider === provider);
      if (servedRoute === undefined) {
        throw new Error('fixture selected a route outside the exact authorization list');
      }
      const now = new Date().toISOString();
      return {
        generationId: `gen-${randomUUID()}`,
        output: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] }],
        finishReason: 'stop',
        usage: {
          schemaVersion: 2,
          requestId: envelope.attribution.requestId,
          attribution: envelope.attribution,
          outcome: 'completed',
          units: [...units],
          usageSource: 'provider_reported',
          resolvedModelReference: servedRoute.modelReference,
          servingProvider: provider,
          deploymentId: servedRoute.deploymentId,
          routeSwitches: 0,
          startedAt: now,
          completedAt: now,
        },
      };
    },
  };
}

async function balanceOf(accountId: string): Promise<{ purchased: string; reserved: string }> {
  const [row] = await getDb()
    .select()
    .from(accountBalances)
    .where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.currency, 'USD')))
    .limit(1);
  return { purchased: row.purchasedBalance, reserved: row.reservedBalance };
}

async function ledgerStateOf(accountId: string) {
  const db = getDb();
  const receipts = await db
    .select({ id: usageReceipts.id, billedAmount: usageReceipts.billedAmount })
    .from(usageReceipts)
    .where(eq(usageReceipts.accountId, accountId));
  const reservations = await db
    .select({ id: usageReservations.id, status: usageReservations.status })
    .from(usageReservations)
    .where(eq(usageReservations.accountId, accountId));
  return { receipts, reservations };
}

const body = (fixture: Fixture) => ({
  model: fixture.modelReference,
  input: 'Say hello.',
  maxOutputTokens: 3000,
});

const bearer = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

/* -------------------------------------------------------------------------- */
/*  The refusal                                                               */
/* -------------------------------------------------------------------------- */

describe('a completed report that metered nothing', () => {
  /*
   * TWO halves catch this, at two boundaries, and the split is worth asserting
   * because each half is invisible in the other's test.
   *
   * A report with an EMPTY unit array never reaches the ledger: the wire schema
   * (`inferenceUsageReportSchema`'s `superRefine`, reached here through
   * `normalizedUsageReportSchema`) refuses `completed` with no units, so
   * `validateCompletion` repudiates the whole answer and the request settles down
   * the FAILURE path — zero units, `estimated`, refund reason `usage_unavailable`.
   * That is the contracts half, and it releases the hold immediately.
   *
   * A report whose units are PRESENT and all zero passes that schema, because
   * `usageQuantitySchema` allows `quantity: 0`. It reaches `settle`, and the
   * api-side half refuses it with `zero-usage` and writes nothing, leaving the hold
   * for the sweeper.
   *
   * Both refuse the customer. They differ in what they write and in which reason
   * they name, and a change that collapsed them would silently move one shape onto
   * the other's path.
   */

  it('WIRE HALF: an empty unit array is repudiated before the ledger, and settles zero', async () => {
    const fixture = await makeFixture();
    const before = await balanceOf(fixture.accountId);
    const seen: InferenceRequest[] = [];

    await withServer(kaanaReporting([], fixture.provider, seen), async (request) => {
      const response = await request('/v1/responses', body(fixture), bearer(fixture.token));

      expect(response.status).not.toBe(200);
      // Named as an unreadable REPORT, not as a settlement problem: the schema
      // refused `completed` with no units, so the edge never believed the answer.
      expect(json(response)).toMatchObject({ code: 'internal_error' });
    });

    // It did reach the data plane, so this is a repudiated answer rather than an
    // admission refusal, which would produce the same non-200 for another reason.
    expect(seen).toHaveLength(1);

    const { receipts, reservations } = await ledgerStateOf(fixture.accountId);
    // The failure path settles ZERO and releases the hold in the same
    // transaction — so unlike the ledger half below, a receipt DOES exist here,
    // billed at nothing, and the money is already back.
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].billedAmount)).toBe(0);
    expect(reservations[0].status).toBe('settled');

    const after = await balanceOf(fixture.accountId);
    expect(Number(after.reserved)).toBe(0);
    expect(Number(after.purchased)).toBeCloseTo(Number(before.purchased), 9);

    // And it is NOT the ledger refusal: nothing reported a settlement failure,
    // which is what distinguishes this half from the next test.
    expect(
      mockedLogger.error.mock.calls.filter((call) => call[0] === 'inference.edge.settlement_failed')
    ).toHaveLength(0);
  });

  it('LEDGER HALF: units present and all zero are refused, and the hold STANDS', async () => {
    const fixture = await makeFixture();
    const before = await balanceOf(fixture.accountId);
    const seen: InferenceRequest[] = [];

    // The residual the wire schema does not close: this validates upstream and
    // still means nothing was metered.
    await withServer(
      kaanaReporting(
        [
          { unit: 'input_tokens', quantity: 0 },
          { unit: 'output_tokens', quantity: 0 },
        ],
        fixture.provider,
        seen
      ),
      async (request) => {
        const response = await request('/v1/responses', body(fixture), bearer(fixture.token));
        // NOT 200. This is the bug: served upstream, accounted for nothing, and a
        // 200 would hand the customer a free completion no invoice can explain.
        expect(response.status).not.toBe(200);
        expect(json(response)).toMatchObject({ code: 'internal_error' });
      }
    );

    expect(seen).toHaveLength(1);

    const { receipts, reservations } = await ledgerStateOf(fixture.accountId);
    // NOTHING was written — the difference from the wire half, which writes a
    // zero receipt.
    expect(receipts).toHaveLength(0);
    // And the hold STANDS, which is what returns the money through the expiry
    // sweep. A refusal that released it here would look identical to the customer
    // and would drop the evidence that a request was served and not charged.
    expect(reservations).toHaveLength(1);
    expect(reservations[0].status).toBe('held');

    const after = await balanceOf(fixture.accountId);
    expect(Number(after.reserved)).toBeGreaterThan(0);
    expect(Number(after.purchased)).toBeLessThan(Number(before.purchased));
    // Nothing was taken: the total across both buckets is unchanged.
    expect(Number(after.purchased) + Number(after.reserved)).toBeCloseTo(
      Number(before.purchased) + Number(before.reserved),
      9
    );
  });

  it('LEDGER HALF is LOUD about it, naming the status', async () => {
    const fixture = await makeFixture();
    const seen: InferenceRequest[] = [];

    await withServer(
      kaanaReporting([{ unit: 'input_tokens', quantity: 0 }], fixture.provider, seen),
      async (request) => {
        await request('/v1/responses', body(fixture), bearer(fixture.token));
      }
    );

    // The generation happened and could not be charged for; that is an Oxy-side
    // failure and it has to be visible, because the customer's refund arrives
    // silently via the sweeper and would otherwise be the only trace.
    const settlementFailures = mockedLogger.error.mock.calls.filter(
      (call) => call[0] === 'inference.edge.settlement_failed'
    );
    expect(settlementFailures).toHaveLength(1);
    expect(settlementFailures[0][1]).toBeInstanceOf(Error);
    // The status is in the message, so this is distinguishable from the other
    // refusals that share this branch.
    expect(String(settlementFailures[0][1])).toContain('zero-usage');
  });

  it('CONTROL: one token is enough to be served, charged and settled', async () => {
    const fixture = await makeFixture();
    const before = await balanceOf(fixture.accountId);
    const seen: InferenceRequest[] = [];

    await withServer(
      kaanaReporting([{ unit: 'input_tokens', quantity: 1 }], fixture.provider, seen),
      async (request) => {
        const response = await request('/v1/responses', body(fixture), bearer(fixture.token));
        // The same fixture, the same path, one non-zero unit — served. Without
        // this, every assertion above is also what a wholly broken edge produces.
        expect(response.status).toBe(200);
      }
    );

    const { receipts, reservations } = await ledgerStateOf(fixture.accountId);
    expect(receipts).toHaveLength(1);
    // $3/M x 1 = 0.000003 exactly.
    expect(Number(receipts[0].billedAmount)).toBeCloseTo(0.000003, 12);
    expect(reservations[0].status).toBe('settled');

    const after = await balanceOf(fixture.accountId);
    expect(Number(after.reserved)).toBe(0);
    expect(Number(before.purchased) - Number(after.purchased)).toBeCloseTo(0.000003, 12);

    // And no settlement failure was logged — the pair to the loudness assertion.
    expect(
      mockedLogger.error.mock.calls.filter((call) => call[0] === 'inference.edge.settlement_failed')
    ).toHaveLength(0);
  });
});
