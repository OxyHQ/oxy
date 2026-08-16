/**
 * The reserve → settle → refund protocol, against a REAL Postgres.
 *
 * ADR 0009 names two properties the tests must be able to FALSIFY rather than
 * confirm: **no path may charge twice**, and **no path may execute unreserved**.
 * Both are here, and both assert that the wrong answer is not produced rather
 * than only that the right one is.
 *
 * ## The concurrency tests are the ones worth reading
 *
 * `Promise.all` does NOT force two transactions to interleave — each can finish
 * before the loop returns to the other — so the intuitive "two racing reserves"
 * test is vacuous: it passes whether or not the code takes a lock. The two real
 * tests below FORCE the interleaving with a second, reserved connection that
 * holds `SELECT … FOR UPDATE` on the balance row and commits only after the
 * contenders are observed BLOCKED — once for two reserves against one account,
 * once for two expiry sweeps over one hold.
 *
 * And the wait asserts its own precondition. `countBalanceRowWaiters` polls
 * `pg_locks` and the wait THROWS if the block never appears, because "the
 * contender never blocked" and "the contender blocked and then behaved
 * correctly" are otherwise the same green. That probe carries its own trap,
 * documented at its definition: Postgres QUEUES waiters, so counting only
 * `transactionid` waits reports one waiter however many are queued, and
 * counting only `relation` reports none at all.
 *
 * Every fixture is scoped to ids this file owns, and every instant is written
 * RELATIVE to now, so a sibling test file seeding rows into the shared database
 * cannot change an answer here.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountBalances } from '../../db/schema/accountBalances';
import {
  billingLedgerEntries,
  billingLedgerPostings,
} from '../../db/schema/billingLedgerEntries';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { billingProfiles } from '../../db/schema/billingProfiles';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { spendingLimitNotifications, spendingLimits } from '../../db/schema/spendingLimits';
import { usageReceipts } from '../../db/schema/usageReceipts';
import { usageRefunds } from '../../db/schema/usageRefunds';
import { usageReservations } from '../../db/schema/usageReservations';
import { users } from '../../db/schema/users';
import {
  expireReservations,
  getAccountBalance,
  provisionBillingProfile,
  recordPromotionalGrant,
  recordTopUp,
  reserve,
  resolveBillingAccount,
  reverseReceipt,
  settle,
  type LedgerAttribution,
} from '../inferenceLedger.service';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

interface Fixture {
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly priceVersionId: string;
  readonly attribution: LedgerAttribution;
}

/** $3 per million input tokens, $15 per million output tokens. */
async function insertPriceVersion(): Promise<string> {
  const [version] = await getDb()
    .insert(priceVersions)
    .values({
      modelReference: `oxy/svc-${randomUUID().slice(0, 8)}`,
      provider: 'oxy-hosted',
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });

  await getDb()
    .insert(priceVersionUnitPrices)
    .values([
      {
        priceVersionId: version.id,
        unit: 'input_tokens',
        amount: '3.000000000000',
        per: 1_000_000,
      },
      {
        priceVersionId: version.id,
        unit: 'output_tokens',
        amount: '15.000000000000',
        per: 1_000_000,
      },
    ]);
  return version.id;
}

async function makeFixture(options: { fund?: string; promotional?: string } = {}): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const [account] = await getDb()
    .insert(users)
    .values({ username: `svc-${suffix}`, email: `svc-${suffix}@example.test` })
    .returning({ id: users.id });

  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Svc ${suffix}`, ownerAccountId: account.id })
    .returning({ id: applications.id });

  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: 'test',
      publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
      type: 'service',
      environment: 'production',
    })
    .returning({ id: applicationCredentials.id });

  await provisionBillingProfile({ accountId: account.id });

  if (options.fund !== undefined) {
    await recordTopUp({
      idempotencyKey: `fund-${randomUUID()}`,
      accountId: account.id,
      currency: 'USD',
      amount: options.fund,
    });
  }
  if (options.promotional !== undefined) {
    await recordPromotionalGrant({
      idempotencyKey: `grant-${randomUUID()}`,
      accountId: account.id,
      currency: 'USD',
      amount: options.promotional,
    });
  }

  return {
    accountId: account.id,
    applicationId: application.id,
    credentialId: credential.id,
    priceVersionId: await insertPriceVersion(),
    attribution: {
      accountId: account.id,
      applicationId: application.id,
      applicationCredentialId: credential.id,
      requestId: `req-${randomUUID()}`,
      environment: 'production',
    },
  };
}

/** Compare two exact decimal strings numerically — `3.0` and `3.000` are one amount. */
async function expectAmount(actual: string, expected: string): Promise<void> {
  const rows = await getDb().execute(
    sql`select (${actual}::numeric = ${expected}::numeric) as equal`
  );
  expect({ actual, expected, equal: rows[0].equal }).toEqual({ actual, expected, equal: true });
}

/**
 * How many backends other than `holderPid` are queued for a row of
 * `account_balances` in THIS database.
 *
 * Two lock shapes, because Postgres queues waiters rather than piling them all
 * onto one lock — measured against a real server, not assumed:
 *
 *  - the FIRST waiter blocks on the holding TRANSACTION (`transactionid`), so a
 *    `relation`-scoped probe reports zero waiters forever;
 *  - every waiter BEHIND it blocks on the intermediary `tuple` lock the first
 *    one holds, so a `transactionid`-scoped probe reports exactly one waiter
 *    forever, however many are queued.
 *
 * A probe with only one of the two branches therefore reads as a comfortable
 * answer in both directions. Scoped to the current database because `pg_locks`
 * spans the whole cluster and this suite shares a server with every other jest
 * worker; the `transactionid` branch needs no such scoping, being pinned to the
 * holder's own pid — and carries none, since a `transactionid` lock has no
 * database. `pg_stat_activity` is not used: it is blank across role splits.
 */
async function countBalanceRowWaiters(holderPid: number): Promise<number> {
  const rows = await getDb().execute(sql`
    select count(distinct w.pid)::int as waiters
    from pg_locks w
    where not w.granted
      and w.pid <> ${holderPid}
      and (
        exists (
          select 1 from pg_locks h
          where h.pid = ${holderPid}
            and h.granted
            and h.locktype = 'transactionid'
            and h.transactionid = w.transactionid
        )
        or (
          w.locktype = 'tuple'
          and w.relation = 'account_balances'::regclass
          and w.database = (select oid from pg_database where datname = current_database())
        )
      )
  `);
  return Number(rows[0].waiters);
}

/**
 * Block until `expected` backends are queued behind `holderPid`, and THROW if
 * they never are.
 *
 * The throw is the point. "The contender never blocked" and "the contender
 * blocked and then behaved correctly" produce the same green otherwise, and the
 * first of those means the lock this whole design rests on is not being taken.
 */
async function waitForBlockedContenders(
  holderPid: number,
  expected = 1,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = await countBalanceRowWaiters(holderPid);
    if (seen >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `only ${seen} of ${expected} backends ever blocked on pid ${holderPid} — ` +
    'the path under test did not take the balance row lock'
  );
}

describe('billing profiles are provisioned deliberately, for accounts of any kind', () => {
  it('creates a profile and its balance row together, idempotently', async () => {
    const f = await makeFixture();
    const again = await provisionBillingProfile({ accountId: f.accountId });
    expect(again.accountId).toBe(f.accountId);

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    expect(balance).not.toBeNull();
    await expectAmount(balance?.purchasedBalance ?? 'missing', '0');
  });

  it('reports not-provisioned for an account nobody has decided about', async () => {
    const suffix = randomUUID().slice(0, 8);
    const [account] = await getDb()
      .insert(users)
      .values({ username: `bare-${suffix}`, email: `bare-${suffix}@example.test` })
      .returning({ id: users.id });

    const resolution = await resolveBillingAccount(getDb(), account.id);
    // NOT collapsed into a zeroed profile: a zero balance means "spent
    // everything" and an absent profile means "nobody has decided who pays".
    expect(resolution.status).toBe('not-provisioned');
  });

  it('bills a child project to its nearest ancestor with a profile', async () => {
    const parent = await makeFixture({ fund: '10.000000000000' });
    const suffix = randomUUID().slice(0, 8);
    const [project] = await getDb()
      .insert(users)
      .values({
        username: `proj-${suffix}`,
        email: `proj-${suffix}@example.test`,
        kind: 'project',
        parentAccountId: parent.accountId,
      })
      .returning({ id: users.id });
    await getDb()
      .execute(sql`insert into user_ancestors (user_id, depth, ancestor_id)
                   values (${project.id}, 0, ${parent.accountId})`);

    const resolution = await resolveBillingAccount(getDb(), project.id);
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.billingAccount.accountId).toBe(parent.accountId);
  });
});

describe('reserve holds the maximum before anything is forwarded', () => {
  it('refuses when the balance cannot cover the ceiling, and writes nothing', async () => {
    const f = await makeFixture({ fund: '0.000001000000' });
    const result = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });

    expect(result.status).toBe('insufficient-funds');
    const rows = await getDb()
      .select({ id: usageReservations.id })
      .from(usageReservations)
      .where(eq(usageReservations.accountId, f.accountId));
    expect(rows).toEqual([]);
  });

  it('spends promotional money before purchased money', async () => {
    const f = await makeFixture({ fund: '10.000000000000', promotional: '2.000000000000' });
    const result = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '3.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    expect(result.status).toBe('reserved');

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    // The whole grant, then $1 of purchased money — never the other way round,
    // which would strand the balance that can expire and cannot be refunded.
    await expectAmount(balance?.promotionalBalance ?? 'missing', '0');
    await expectAmount(balance?.purchasedBalance ?? 'missing', '9.000000000000');
    await expectAmount(balance?.reservedBalance ?? 'missing', '3.000000000000');
  });

  it('returns the original hold on a retry, and moves the balance once', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const key = `r-${randomUUID()}`;
    const input = {
      idempotencyKey: key,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '2.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    };

    const first = await reserve(input);
    const second = await reserve(input);

    expect(first.status).toBe('reserved');
    expect(second.status).toBe('already-reserved');
    if (first.status !== 'reserved' || second.status !== 'already-reserved') return;
    expect(second.reservation.reservationId).toBe(first.reservation.reservationId);

    const rows = await getDb()
      .select({ id: usageReservations.id })
      .from(usageReservations)
      .where(eq(usageReservations.idempotencyKey, key));
    expect(rows.length).toBe(1);

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    await expectAmount(balance?.reservedBalance ?? 'missing', '2.000000000000');
    await expectAmount(balance?.purchasedBalance ?? 'missing', '8.000000000000');
  });

  it('refuses a currency the account is not billed in', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const result = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'EUR',
      expiresInSeconds: 300,
    });
    expect(result.status).toBe('currency-mismatch');
  });
});

describe('settle charges the exact usage and releases the rest atomically', () => {
  async function reserveAndSettle(f: Fixture, units: Record<string, number>) {
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error(`reserve failed: ${reserved.status}`);

    const settled = await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'completed',
      usageSource: 'provider_reported',
      units,
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });
    return { reserved, settled };
  }

  it('computes the charge from the price version, in SQL, exactly', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const { settled } = await reserveAndSettle(f, { input_tokens: 1000, output_tokens: 200 });

    expect(settled.status).toBe('settled');
    if (settled.status !== 'settled') return;
    // 1000 * 3/1e6 + 200 * 15/1e6 = 0.003 + 0.003 = 0.006
    await expectAmount(settled.receipt.billedAmount, '0.006000000000');
    await expectAmount(settled.releasedAmount, '0.994000000000');
  });

  it('returns the unused hold to the balance in the same transaction', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    await reserveAndSettle(f, { input_tokens: 1000, output_tokens: 200 });

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    await expectAmount(balance?.reservedBalance ?? 'missing', '0');
    await expectAmount(balance?.purchasedBalance ?? 'missing', '9.994000000000');
  });

  it('settles zero and releases the whole hold when the provider produced nothing', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');

    const settled = await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'failed',
      usageSource: 'provider_reported',
      units: {},
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });

    expect(settled.status).toBe('settled');
    if (settled.status !== 'settled') return;
    await expectAmount(settled.receipt.billedAmount, '0');

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    await expectAmount(balance?.purchasedBalance ?? 'missing', '10.000000000000');

    const [refund] = await getDb()
      .select({ reason: usageRefunds.reason })
      .from(usageRefunds)
      .where(eq(usageRefunds.accountId, f.accountId));
    expect(refund.reason).toBe('upstream_failure');
  });

  it('labels a cancellation and a partial stream by their own reasons', async () => {
    for (const [outcome, reason] of [
      ['cancelled', 'client_cancelled'],
      ['partial', 'partial_stream'],
    ] as const) {
      const f = await makeFixture({ fund: '10.000000000000' });
      const reserved = await reserve({
        idempotencyKey: `r-${randomUUID()}`,
        attribution: f.attribution,
        ceilingPriceVersionId: f.priceVersionId,
        maxAmount: '1.000000000000',
        currency: 'USD',
        expiresInSeconds: 300,
      });
      if (reserved.status !== 'reserved') throw new Error('reserve failed');
      await settle({
        idempotencyKey: `s-${randomUUID()}`,
        reservationId: reserved.reservation.reservationId,
        attribution: f.attribution,
        outcome,
        usageSource: 'provider_reported',
        units: { output_tokens: 10 },
        resolvedModelReference: 'oxy/test',
        servingProvider: 'oxy-hosted',
        priceVersionId: f.priceVersionId,
      });

      const [refund] = await getDb()
        .select({ reason: usageRefunds.reason })
        .from(usageRefunds)
        .where(eq(usageRefunds.accountId, f.accountId));
      expect(refund.reason).toBe(reason);
    }
  });

  it('marks an estimated settlement as usage_unavailable, whatever the outcome', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');
    await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'completed',
      usageSource: 'estimated',
      units: { output_tokens: 10 },
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });

    const [refund] = await getDb()
      .select({ reason: usageRefunds.reason })
      .from(usageRefunds)
      .where(eq(usageRefunds.accountId, f.accountId));
    // An estimate that is indistinguishable from a reported figure is one
    // nobody can reconcile later.
    expect(refund.reason).toBe('usage_unavailable');
  });

  it('never charges twice for one settlement key', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');

    const input = {
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'completed' as const,
      usageSource: 'provider_reported' as const,
      units: { input_tokens: 1000 },
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    };

    const first = await settle(input);
    const second = await settle(input);

    expect(first.status).toBe('settled');
    // The retry returns the ORIGINAL receipt and writes nothing new. It does
    // NOT go on to report the reservation as no longer held, which is what a
    // naive re-run would answer.
    expect(second.status).toBe('already-settled');

    const receipts = await getDb()
      .select({ id: usageReceipts.id })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, f.accountId));
    expect(receipts.length).toBe(1);

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    await expectAmount(balance?.purchasedBalance ?? 'missing', '9.997000000000');
  });

  it('refuses a unit the price version does not price, rather than undercharging', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');

    const settled = await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'completed',
      usageSource: 'provider_reported',
      // `images` is not priced in this version. A join would silently drop it.
      units: { input_tokens: 1000, images: 4 },
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });

    expect(settled.status).toBe('unpriced-units');
    if (settled.status !== 'unpriced-units') return;
    expect(settled.unpricedUnits).toBe(1);

    // And nothing was written — the wrong answer (an undercharged receipt) is
    // not produced.
    const receipts = await getDb()
      .select({ id: usageReceipts.id })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, f.accountId));
    expect(receipts).toEqual([]);
  });

  it('refuses a charge above the hold that authorised it, and writes nothing', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '0.000001000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');

    const settled = await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { output_tokens: 1_000_000 },
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });

    expect(settled.status).toBe('settlement-exceeds-reservation');
    const receipts = await getDb()
      .select({ id: usageReceipts.id })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, f.accountId));
    expect(receipts).toEqual([]);
    // The hold survives, so `expireReservations` returns the money on its own.
    const [held] = await getDb()
      .select({ status: usageReservations.status })
      .from(usageReservations)
      .where(eq(usageReservations.id, reserved.reservation.reservationId));
    expect(held.status).toBe('held');
  });

  it('snapshots the prices it charged onto the receipt', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const { settled } = await reserveAndSettle(f, { input_tokens: 1000 });
    if (settled.status !== 'settled') throw new Error('settle failed');

    const snapshot = await getDb().execute(sql`
      select unit, amount::text as amount, per
      from usage_receipt_unit_prices
      where receipt_id = ${settled.receipt.receiptId}
      order by unit
    `);
    // A COPY, so the receipt's arithmetic is checkable without the price
    // version still existing.
    expect(snapshot.length).toBe(2);
    expect(snapshot.map((row) => row.unit).sort()).toEqual(['input_tokens', 'output_tokens']);
  });
});

/**
 * The unit set PARTITIONS a request — `cached_input_tokens` is a sibling of
 * `input_tokens`, not a detail inside it, and the same for `reasoning_tokens`
 * and `output_tokens` (`@oxyhq/contracts`' `USAGE_UNITS`). `computeCharge`
 * prices every reported unit and sums, so that sum is the request's cost only
 * under the partition reading.
 *
 * Every OpenAI-compatible provider reports the OTHER way round: `prompt_tokens`
 * includes its cached tokens and `completion_tokens` includes its reasoning
 * tokens. A normalizer forwarding those numbers unchanged would be charged for
 * the cached and reasoning tokens twice — once inside their parent and once on
 * their own line — with no symptom, because the receipt stays internally
 * consistent and every total still looks plausible.
 *
 * So: ONE physical request, reported both ways. A 10 000-token prompt of which
 * 9 000 were served from cache, and a 1 000-token completion of which 800 were
 * reasoning.
 *
 * The four prices are four DIFFERENT numbers so no two readings can agree by
 * arithmetic accident, and so a cache discount and a reasoning price are each
 * exercised as their own line rather than inheriting a parent's.
 */
describe('cached and reasoning tokens are priced as siblings, never as details of a total', () => {
  /** What the data plane owes Oxy: the partition, with nothing counted twice. */
  const PARTITIONED = {
    input_tokens: 1_000,
    cached_input_tokens: 9_000,
    output_tokens: 200,
    reasoning_tokens: 800,
  };
  /** The same request as a provider states it, children left inside parents. */
  const NESTED = {
    input_tokens: 10_000,
    cached_input_tokens: 9_000,
    output_tokens: 1_000,
    reasoning_tokens: 800,
  };

  // 1000·3/1e6 + 9000·0.3/1e6 + 200·15/1e6 + 800·30/1e6
  const PARTITIONED_CHARGE = '0.032700000000';
  // 10000·3/1e6 + 9000·0.3/1e6 + 1000·15/1e6 + 800·30/1e6
  const NESTED_CHARGE = '0.071700000000';
  // 9000 cached at the INPUT price + 800 reasoning at the OUTPUT price: exactly
  // the two lines the nested reading pays for a second time.
  const OVERCHARGE = '0.039000000000';

  /** $3 / $0.30 / $15 / $30 per million, for the four token units. */
  async function insertTokenPriceVersion(): Promise<string> {
    const [version] = await getDb()
      .insert(priceVersions)
      .values({
        modelReference: `oxy/reasoner-${randomUUID().slice(0, 8)}`,
        provider: 'oxy-hosted',
        status: 'active',
        effectiveFrom: new Date(Date.now() - 60_000),
      })
      .returning({ id: priceVersions.id });

    await getDb()
      .insert(priceVersionUnitPrices)
      .values([
        { priceVersionId: version.id, unit: 'input_tokens', amount: '3.000000000000', per: 1_000_000 },
        {
          priceVersionId: version.id,
          unit: 'cached_input_tokens',
          amount: '0.300000000000',
          per: 1_000_000,
        },
        { priceVersionId: version.id, unit: 'output_tokens', amount: '15.000000000000', per: 1_000_000 },
        {
          priceVersionId: version.id,
          unit: 'reasoning_tokens',
          amount: '30.000000000000',
          per: 1_000_000,
        },
      ]);
    return version.id;
  }

  async function settleReport(
    units: Record<string, number>
  ): Promise<{ billedAmount: string; receiptId: string }> {
    const f = await makeFixture({ fund: '10.000000000000' });
    const priceVersionId = await insertTokenPriceVersion();
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error(`reserve failed: ${reserved.status}`);

    const settled = await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'completed',
      usageSource: 'provider_reported',
      units,
      resolvedModelReference: 'oxy/reasoner',
      servingProvider: 'oxy-hosted',
      priceVersionId,
    });
    if (settled.status !== 'settled') throw new Error(`settle failed: ${settled.status}`);
    return { billedAmount: settled.receipt.billedAmount, receiptId: settled.receipt.receiptId };
  }

  it('charges a partitioned report once per unit, at that unit own price', async () => {
    const { billedAmount, receiptId } = await settleReport(PARTITIONED);
    await expectAmount(billedAmount, PARTITIONED_CHARGE);

    // The four quantities are kept apart on the receipt, so the partition it was
    // charged under is reconstructible from the record itself.
    const [row] = await getDb()
      .select({
        inputTokens: usageReceipts.inputTokens,
        cachedInputTokens: usageReceipts.cachedInputTokens,
        outputTokens: usageReceipts.outputTokens,
        reasoningTokens: usageReceipts.reasoningTokens,
      })
      .from(usageReceipts)
      .where(eq(usageReceipts.id, receiptId));
    expect(row).toEqual({
      inputTokens: 1_000,
      cachedInputTokens: 9_000,
      outputTokens: 200,
      reasoningTokens: 800,
    });
  });

  it('bills the same request more than twice over when children stay inside parents', async () => {
    const { billedAmount: partitioned } = await settleReport(PARTITIONED);
    const { billedAmount: nested } = await settleReport(NESTED);

    await expectAmount(partitioned, PARTITIONED_CHARGE);
    await expectAmount(nested, NESTED_CHARGE);

    // Stated as the difference as well as the two totals: the failure this test
    // exists for is not "the number moved", it is "the cached and reasoning
    // tokens were charged a second time, at their parents' prices".
    const [difference] = await getDb().execute(
      sql`select (${nested}::numeric - ${partitioned}::numeric)::text as overcharge`
    );
    await expectAmount(String(difference.overcharge), OVERCHARGE);
  });
});

describe('expiry is a refund with a reason, never a silent release', () => {
  it('releases a past-deadline hold and records why', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '4.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');

    // The deadline is moved RELATIVE to now — never pinned to an absolute past
    // date, which would collide with a sibling file's own expiry pass.
    await getDb()
      .update(usageReservations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(usageReservations.id, reserved.reservation.reservationId));

    await expireReservations(500);

    const [row] = await getDb()
      .select({ status: usageReservations.status })
      .from(usageReservations)
      .where(eq(usageReservations.id, reserved.reservation.reservationId));
    expect(row.status).toBe('expired');

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    await expectAmount(balance?.reservedBalance ?? 'missing', '0');
    await expectAmount(balance?.purchasedBalance ?? 'missing', '10.000000000000');

    const [refund] = await getDb()
      .select({ reason: usageRefunds.reason, amount: usageRefunds.amount })
      .from(usageRefunds)
      .where(eq(usageRefunds.accountId, f.accountId));
    expect(refund.reason).toBe('unused_reservation');
    await expectAmount(refund.amount, '4.000000000000');
  });

  it('leaves a still-live hold alone', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 3600,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');

    await expireReservations(500);

    const [row] = await getDb()
      .select({ status: usageReservations.status })
      .from(usageReservations)
      .where(eq(usageReservations.id, reserved.reservation.reservationId));
    expect(row.status).toBe('held');
  });
});

describe('a settled charge is reversed by appending, never by editing', () => {
  it('returns the money and leaves the receipt untouched', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '5.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');
    const settled = await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { input_tokens: 1_000_000 },
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });
    if (settled.status !== 'settled') throw new Error('settle failed');

    const reversal = await reverseReceipt({
      idempotencyKey: `rev-${randomUUID()}`,
      receiptId: settled.receipt.receiptId,
      reason: 'billing_correction',
    });
    expect(reversal.status).toBe('reversed');

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    await expectAmount(balance?.purchasedBalance ?? 'missing', '10.000000000000');

    const [receipt] = await getDb()
      .select({ billedAmount: usageReceipts.billedAmount })
      .from(usageReceipts)
      .where(eq(usageReceipts.id, settled.receipt.receiptId));
    await expectAmount(receipt.billedAmount, '3.000000000000');
  });

  it('refuses to reverse more than was settled', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');
    const settled = await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { input_tokens: 1000 },
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });
    if (settled.status !== 'settled') throw new Error('settle failed');

    const reversal = await reverseReceipt({
      idempotencyKey: `rev-${randomUUID()}`,
      receiptId: settled.receipt.receiptId,
      reason: 'duplicate_charge',
      amount: '5.000000000000',
    });
    expect(reversal.status).toBe('exceeds-settled-amount');
  });

  it('is idempotent on its own key', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');
    const settled = await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { input_tokens: 1000 },
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });
    if (settled.status !== 'settled') throw new Error('settle failed');

    const key = `rev-${randomUUID()}`;
    const first = await reverseReceipt({
      idempotencyKey: key,
      receiptId: settled.receipt.receiptId,
      reason: 'billing_correction',
    });
    const second = await reverseReceipt({
      idempotencyKey: key,
      receiptId: settled.receipt.receiptId,
      reason: 'billing_correction',
    });

    expect(first.status).toBe('reversed');
    expect(second.status).toBe('already-reversed');

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    // Refunded ONCE. Refunding twice would put the account above what it funded.
    await expectAmount(balance?.purchasedBalance ?? 'missing', '10.000000000000');
  });
});

describe('the projection agrees with the journal', () => {
  it('recomputes every bucket from the postings and finds the same numbers', async () => {
    const f = await makeFixture({ fund: '10.000000000000', promotional: '1.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '2.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');
    await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution: f.attribution,
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { input_tokens: 100_000 },
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });

    const rows = await getDb().execute(sql`
      with journal as (
        select p.destination_account as account, p.amount as amount
        from billing_ledger_postings p
        join billing_ledger_entries e on e.id = p.entry_id
        where e.account_id = ${f.accountId}
        union all
        select p.source_account, -p.amount
        from billing_ledger_postings p
        join billing_ledger_entries e on e.id = p.entry_id
        where e.account_id = ${f.accountId}
      ),
      netted as (
        select account, sum(amount) as net from journal group by account
      )
      select
        coalesce((select net from netted where account = 'purchased_funds'), 0)::text as purchased,
        coalesce((select net from netted where account = 'promotional_funds'), 0)::text as promotional,
        coalesce((select net from netted where account = 'reserved_funds'), 0)::text as reserved,
        (-coalesce((select net from netted where account = 'invoice_receivable'), 0))::text as invoiced,
        (select count(*)::int from journal) as postings
    `);

    const journal = rows[0];
    // The vacuity floor: an equality between two zeroes agrees for free.
    expect(Number(journal.postings)).toBeGreaterThan(2);

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    await expectAmount(balance?.purchasedBalance ?? 'missing', String(journal.purchased));
    await expectAmount(balance?.promotionalBalance ?? 'missing', String(journal.promotional));
    await expectAmount(balance?.reservedBalance ?? 'missing', String(journal.reserved));
    await expectAmount(balance?.invoicedOutstanding ?? 'missing', String(journal.invoiced));
  });
});

describe('spending limits stop a request before it executes', () => {
  it('refuses a reservation past a hard-stop budget', async () => {
    const f = await makeFixture({ fund: '100.000000000000' });
    await getDb().insert(spendingLimits).values({
      accountId: f.accountId,
      scope: 'account',
      scopeAccountId: f.accountId,
      period: 'monthly',
      limitAmount: '1.000000000000',
      enforcement: 'hard_stop',
    });

    const result = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '5.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });

    expect(result.status).toBe('spending-limit-exceeded');
    const rows = await getDb()
      .select({ id: usageReservations.id })
      .from(usageReservations)
      .where(eq(usageReservations.accountId, f.accountId));
    expect(rows).toEqual([]);
  });

  it('lets a soft-stop budget through, and says it was passed', async () => {
    const f = await makeFixture({ fund: '100.000000000000' });
    await getDb().insert(spendingLimits).values({
      accountId: f.accountId,
      scope: 'credential',
      scopeApplicationCredentialId: f.credentialId,
      period: 'daily',
      limitAmount: '1.000000000000',
      enforcement: 'soft_stop',
      alertThresholdBps: [7500, 10000],
    });

    const result = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '5.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });

    expect(result.status).toBe('reserved');
    if (result.status !== 'reserved') return;
    expect(result.softStopsPassed.length).toBe(1);

    const notifications = await getDb()
      .select({ thresholdBps: spendingLimitNotifications.thresholdBps })
      .from(spendingLimitNotifications)
      .innerJoin(spendingLimits, eq(spendingLimits.id, spendingLimitNotifications.spendingLimitId))
      .where(eq(spendingLimits.accountId, f.accountId));
    // Both thresholds crossed at once, and each recorded exactly once. Sorted
    // NUMERICALLY — the default comparator is lexicographic, which orders
    // 10000 before 7500 and would make this assertion about string order.
    expect(notifications.map((row) => row.thresholdBps).sort((a, b) => a - b)).toEqual([
      7500, 10000,
    ]);
  });

  it('records a crossed threshold once per period, not once per request', async () => {
    const f = await makeFixture({ fund: '100.000000000000' });
    await getDb().insert(spendingLimits).values({
      accountId: f.accountId,
      scope: 'application',
      scopeApplicationId: f.applicationId,
      period: 'monthly',
      limitAmount: '10.000000000000',
      enforcement: 'soft_stop',
      alertThresholdBps: [2500],
    });

    for (let index = 0; index < 3; index += 1) {
      await reserve({
        idempotencyKey: `r-${randomUUID()}`,
        attribution: f.attribution,
        ceilingPriceVersionId: f.priceVersionId,
        maxAmount: '3.000000000000',
        currency: 'USD',
        expiresInSeconds: 300,
      });
    }

    const notifications = await getDb()
      .select({ id: spendingLimitNotifications.id })
      .from(spendingLimitNotifications)
      .innerJoin(spendingLimits, eq(spendingLimits.id, spendingLimitNotifications.spendingLimitId))
      .where(eq(spendingLimits.accountId, f.accountId));
    expect(notifications.length).toBe(1);
  });
});

describe('two reserves against one account are serialized by the balance row', () => {
  it('makes the loser re-read the committed balance instead of a stale one', async () => {
    const f = await makeFixture({ fund: '5.000000000000' });

    const client = getDb().$client;
    const holder = await client.reserve();
    let committed = false;
    try {
      await holder.unsafe('begin');
      const [{ pid }] = await holder.unsafe<{ pid: number }[]>('select pg_backend_pid() as pid');

      // The vacuity floor for the probe: with no contender there is nothing
      // waiting on this pid, so a non-zero count later means something really
      // blocked.
      expect(await countBalanceRowWaiters(pid)).toBe(0);

      await holder.unsafe(
        'select * from account_balances where account_id = $1 and currency = $2 for update',
        [f.accountId, 'USD']
      );

      // Drain the balance from inside the holding transaction. Uncommitted, so
      // a contender that read WITHOUT taking the lock would still see $5.
      await holder.unsafe(
        'update account_balances set purchased_balance = 0 where account_id = $1 and currency = $2',
        [f.accountId, 'USD']
      );

      const contender = reserve({
        idempotencyKey: `r-${randomUUID()}`,
        attribution: f.attribution,
        ceilingPriceVersionId: f.priceVersionId,
        maxAmount: '4.000000000000',
        currency: 'USD',
        expiresInSeconds: 300,
      });

      await waitForBlockedContenders(pid);
      await holder.unsafe('commit');

      committed = true;

      const result = await contender;
      // The WRONG answer is the one asserted against: a contender that decided
      // against the balance it read before the lock would answer `reserved`.
      expect(result.status).toBe('insufficient-funds');
      expect(result.status).not.toBe('reserved');
    } finally {
      // Only if the commit above was never reached — a swallowed rollback error
      // would hide a real failure of this connection.
      if (!committed) await holder.unsafe('rollback');
      holder.release();
    }
  });

  it('takes exactly one hold when two identical reserves run at once', async () => {
    // `Promise.all` does not force these to interleave, so this case is about
    // the unique key rather than the lock — the interleaving proof is above.
    const f = await makeFixture({ fund: '10.000000000000' });
    const input = {
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '3.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    };

    const [a, b] = await Promise.all([reserve(input), reserve(input)]);
    expect([a.status, b.status].filter((status) => status === 'reserved').length).toBe(1);

    const rows = await getDb()
      .select({ id: usageReservations.id })
      .from(usageReservations)
      .where(eq(usageReservations.idempotencyKey, input.idempotencyKey));
    expect(rows.length).toBe(1);

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    // Deducted ONCE. Two deductions would leave $4.
    await expectAmount(balance?.purchasedBalance ?? 'missing', '7.000000000000');
  });

  it('writes one ledger entry per hold, with postings that sum to the hold', async () => {
    const f = await makeFixture({ fund: '10.000000000000', promotional: '1.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '3.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');

    const entries = await getDb()
      .select({ id: billingLedgerEntries.id })
      .from(billingLedgerEntries)
      .where(
        and(
          eq(billingLedgerEntries.reservationId, reserved.reservation.reservationId),
          eq(billingLedgerEntries.kind, 'reservation_hold')
        )
      );
    expect(entries.length).toBe(1);

    const postings = await getDb()
      .select({ amount: billingLedgerPostings.amount })
      .from(billingLedgerPostings)
      .where(eq(billingLedgerPostings.entryId, entries[0].id));
    // Two buckets drawn: the whole $1 grant, then $2 of purchased money.
    expect(postings.length).toBe(2);

    const [total] = await getDb().execute(sql`
      select sum(amount)::text as total
      from billing_ledger_postings
      where entry_id = ${entries[0].id}
    `);
    await expectAmount(String(total.total), '3.000000000000');
  });
});

/**
 * `server.ts` runs `expireReservations` on a fixed interval, so a run slower
 * than the interval is overtaken by the next one and two passes can select the
 * same due hold. Releasing it twice credits the customer twice, which is a money
 * bug that leaves the projection and the journal agreeing with each other and
 * both wrong. These two tests are why the schedule is safe.
 *
 * Both go red when the guards are defeated — measured, by removing the status
 * re-read and keying the refund per call instead of per reservation. The red
 * arrives as `account_balances_reserved_check`: a second release drives
 * `reserved_balance` below zero and Postgres refuses the statement. That is a
 * fourth layer under the three in `expireReservations`'s own doc comment, and it
 * is worth knowing it is there, because it is what makes the worst case of a
 * double release a failed transaction rather than a wrong balance.
 */
describe('two expiry sweeps over one hold release it exactly once', () => {
  /** A funded account with a hold whose deadline has already passed. */
  async function makeDueHold(): Promise<{ f: Fixture; reservationId: string }> {
    const f = await makeFixture({ fund: '10.000000000000' });
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '4.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error('reserve failed');

    // RELATIVE to now, never an absolute past date — a pinned instant collides
    // with a sibling file's own expiry pass against the shared database.
    await getDb()
      .update(usageReservations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(usageReservations.id, reserved.reservation.reservationId));

    return { f, reservationId: reserved.reservation.reservationId };
  }

  async function countRefunds(reservationId: string): Promise<number> {
    const rows = await getDb()
      .select({ id: usageRefunds.id })
      .from(usageRefunds)
      .where(eq(usageRefunds.reservationId, reservationId));
    return rows.length;
  }

  async function countExpiryEntries(reservationId: string): Promise<number> {
    const rows = await getDb()
      .select({ id: billingLedgerEntries.id })
      .from(billingLedgerEntries)
      .where(
        and(
          eq(billingLedgerEntries.reservationId, reservationId),
          eq(billingLedgerEntries.kind, 'reservation_expiry')
        )
      );
    return rows.length;
  }

  it('serializes on the balance row when both passes see the hold as held', async () => {
    // The real overlap, FORCED rather than hoped for. `Promise.all` alone does
    // not interleave two transactions — each can finish before the loop returns
    // to the other — so a bare concurrent call would pass whether or not the
    // release takes a lock at all. Here an outside connection holds the balance
    // row, both sweeps are observed BLOCKED on it, and only then is it released:
    // at that moment both have scanned, both selected this hold, and neither has
    // seen the other's write. That is precisely the state a slow run overtaken
    // by the next tick produces.
    const { f, reservationId } = await makeDueHold();

    const client = getDb().$client;
    const holder = await client.reserve();
    let committed = false;
    try {
      await holder.unsafe('begin');
      const [{ pid }] = await holder.unsafe<{ pid: number }[]>('select pg_backend_pid() as pid');

      // Vacuity floor for the probe: nothing is waiting on this pid yet, so a
      // count of 2 later means two backends really blocked.
      expect(await countBalanceRowWaiters(pid)).toBe(0);

      await holder.unsafe(
        'select * from account_balances where account_id = $1 and currency = $2 for update',
        [f.accountId, 'USD']
      );

      const sweeps = Promise.all([expireReservations(500), expireReservations(500)]);

      // Throws if two backends never block — which would mean the release path
      // does not take the lock, and this test had been proving nothing.
      await waitForBlockedContenders(pid, 2);
      await holder.unsafe('commit');
      committed = true;

      const [first, second] = await sweeps;

      // Exactly one pass released it. Asserted as an equality on the total, so
      // the WRONG answer — both passes reporting a release — fails here rather
      // than only downstream.
      const releases = [...first, ...second].filter((r) => r.reservationId === reservationId);
      expect(releases.length).toBe(1);
      await expectAmount(releases[0].releasedAmount, '4.000000000000');
    } finally {
      if (!committed) await holder.unsafe('rollback');
      holder.release();
    }

    // One refund, one journal entry, and the money back exactly once. The
    // non-zero floors matter as much as the equalities: a sweep that released
    // NOTHING would satisfy "not twice" too.
    expect(await countRefunds(reservationId)).toBe(1);
    expect(await countExpiryEntries(reservationId)).toBe(1);

    const [row] = await getDb()
      .select({ status: usageReservations.status })
      .from(usageReservations)
      .where(eq(usageReservations.id, reservationId));
    expect(row.status).toBe('expired');

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    await expectAmount(balance?.reservedBalance ?? 'missing', '0');
    // Restored to the full deposit — not $14, which is what a second release
    // of the same $4 hold would leave.
    await expectAmount(balance?.purchasedBalance ?? 'missing', '10.000000000000');
  });

  it('refuses a second release even with the status guard defeated', async () => {
    // Layer 3, on its own. The lock above makes this state unreachable today:
    // a second pass cannot observe `held` once the first has committed, so the
    // status re-read is what actually returns null in production. This test
    // re-arms the status by hand to reach past that guard and land on the one
    // behind it — the `expire:<id>` idempotency key — because a defence in
    // depth nobody exercises is a defence nobody knows is still there, and the
    // ordering that makes it redundant is a property of `expireOne`'s current
    // shape rather than of the schema.
    const { f, reservationId } = await makeDueHold();

    const first = await expireReservations(500);
    expect(first.filter((r) => r.reservationId === reservationId).length).toBe(1);

    // Put the hold back the way the first pass found it, refund row and all
    // still in place — the state a status check alone would wave through.
    await getDb()
      .update(usageReservations)
      .set({ status: 'held', expiresAt: new Date(Date.now() - 1000) })
      .where(eq(usageReservations.id, reservationId));

    const second = await expireReservations(500);
    expect(second.filter((r) => r.reservationId === reservationId).length).toBe(0);

    expect(await countRefunds(reservationId)).toBe(1);
    expect(await countExpiryEntries(reservationId)).toBe(1);

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    await expectAmount(balance?.purchasedBalance ?? 'missing', '10.000000000000');
  });
});

describe('an invoiced account draws against its credit limit', () => {
  it('reserves with no prepaid balance at all, and records what is owed', async () => {
    const f = await makeFixture();
    // The profile is provisioned prepaid by default; switching it here is the
    // operator decision an invoiced account represents.
    await getDb()
      .update(billingProfiles)
      .set({ billingMode: 'invoiced', creditLimit: '50.000000000000' })
      .where(eq(billingProfiles.accountId, f.accountId));

    const result = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '20.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    expect(result.status).toBe('reserved');

    const balance = await getAccountBalance(getDb(), f.accountId, 'USD');
    await expectAmount(balance?.invoicedOutstanding ?? 'missing', '20.000000000000');
    await expectAmount(balance?.purchasedBalance ?? 'missing', '0');
  });

  it('refuses past the credit limit', async () => {
    const f = await makeFixture();
    await getDb()
      .update(billingProfiles)
      .set({ billingMode: 'invoiced', creditLimit: '5.000000000000' })
      .where(eq(billingProfiles.accountId, f.accountId));

    const result = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: f.attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '20.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    expect(result.status).toBe('insufficient-funds');
  });
});

describe('a delegated user never changes who is charged', () => {
  it('bills the same account with and without the delegated id', async () => {
    const withUser = await makeFixture({ fund: '10.000000000000' });
    const suffix = randomUUID().slice(0, 8);
    const [endUser] = await getDb()
      .insert(users)
      .values({ username: `deleg-${suffix}`, email: `deleg-${suffix}@example.test` })
      .returning({ id: users.id });

    const result = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution: { ...withUser.attribution, delegatedUserId: endUser.id },
      ceilingPriceVersionId: withUser.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    expect(result.status).toBe('reserved');
    if (result.status !== 'reserved') return;
    // The application's owner account, never the delegated person.
    expect(result.reservation.billingAccountId).toBe(withUser.accountId);

    const endUserBalance = await getAccountBalance(getDb(), endUser.id, 'USD');
    expect(endUserBalance).toBeNull();
  });
});
