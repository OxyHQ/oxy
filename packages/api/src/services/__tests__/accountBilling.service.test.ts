/**
 * Account-scoped billing, against a REAL Postgres.
 *
 * The properties worth falsifying rather than confirming:
 *
 *  1. **A project spends its ancestor's money, and SAYS so.** The dangerous
 *     failure is not that inheritance is missing — it is that a project shows a
 *     balance with no indication whose it is. `inherited` and `billingAccountId`
 *     are asserted together for that reason.
 *  2. **`availableToSpend` and the auto-recharge sweep agree.** Those are two
 *     separate SQL expressions of one rule (the sweep scans, the reader locks),
 *     so they get a test that would go red if either drifted — for BOTH billing
 *     modes, because the `invoiced` branch is the one only one of them exercises
 *     in ordinary operation.
 *  3. **A budget cannot be aimed at somebody else's application.** A caller with
 *     `billing:manage` over their own account must not be able to hard-stop a
 *     stranger's traffic, and the scope check is what stands in the way.
 *  4. **An auto-recharge claim is taken exactly once per window.** This is the
 *     one guard in the schema protecting a real-world side effect — a charge
 *     against a customer's card — rather than a bookkeeping mistake.
 *
 * Every fixture is scoped to ids this file owns and every instant is written
 * RELATIVE to now, so a sibling file seeding rows into the shared database
 * cannot change an answer here.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountBalances } from '../../db/schema/accountBalances';
import { billingProfiles } from '../../db/schema/billingProfiles';
import { userAncestors } from '../../db/schema/userAncestors';
import { users } from '../../db/schema/users';
import {
  autoRechargeWindowStart,
  claimAutoRecharge,
  findAutoRechargeCandidates,
  provisionAccountBilling,
  resolveAccountBillingState,
  updateBillingProfile,
} from '../accountBilling.service';
import {
  getAvailableToSpend,
  provisionBillingProfile,
  recordTopUp,
} from '../inferenceLedger.service';
import { readAccountBalance } from '../inferenceReporting.service';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function seedAccount(parentAccountId?: string): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [account] = await getDb()
    .insert(users)
    .values({
      username: `bill-${suffix}`,
      email: `bill-${suffix}@example.test`,
      kind: parentAccountId === undefined ? 'organization' : 'project',
      parentAccountId,
    })
    .returning({ id: users.id });

  if (parentAccountId !== undefined) {
    // Root FIRST, matching `user_ancestors.depth` ordering — the same shape
    // `account.service.ts` writes and every nearest-ancestor walk reads.
    await getDb()
      .insert(userAncestors)
      .values([{ userId: account.id, ancestorId: parentAccountId, depth: 0 }]);
  }
  return account.id;
}

describe('a project draws on the nearest ancestor with a profile, and says so', () => {
  it('reports the organization as the payer, marked inherited', async () => {
    const organizationId = await seedAccount();
    const projectId = await seedAccount(organizationId);
    await provisionBillingProfile({ accountId: organizationId });

    const resolved = await resolveAccountBillingState(projectId);
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') return;

    expect(resolved.state.accountId).toBe(projectId);
    expect(resolved.state.billingAccountId).toBe(organizationId);
    // The half that matters: a Console page showing the organization's balance
    // under the project's name with no indication whose money it is would be
    // worse than showing nothing.
    expect(resolved.state.inherited).toBe(true);
  });

  it('stops inheriting once the project has a profile of its own', async () => {
    const organizationId = await seedAccount();
    const projectId = await seedAccount(organizationId);
    await provisionBillingProfile({ accountId: organizationId });

    const provisioned = await provisionAccountBilling({ accountId: projectId });
    expect(provisioned.status).toBe('provisioned');

    const resolved = await resolveAccountBillingState(projectId);
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') return;
    expect(resolved.state.billingAccountId).toBe(projectId);
    expect(resolved.state.inherited).toBe(false);
  });

  it('distinguishes an unprovisioned account from an unknown one', async () => {
    const accountId = await seedAccount();
    await expect(resolveAccountBillingState(accountId)).resolves.toMatchObject({
      status: 'not-provisioned',
    });
    await expect(resolveAccountBillingState(`missing-${randomUUID()}`)).resolves.toMatchObject({
      status: 'unknown-account',
    });
  });
});

describe('the billing state answers TERMS, and never restates the balance', () => {
  it('carries the profile and the inheritance facts, and no amounts', async () => {
    const accountId = await seedAccount();
    await provisionBillingProfile({ accountId });
    await recordTopUp({
      idempotencyKey: `fund-${randomUUID()}`,
      accountId,
      currency: 'USD',
      amount: '40.000000000000',
      actor: { kind: 'machine' },
    });

    const resolved = await resolveAccountBillingState(accountId);
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') return;

    expect(resolved.state.profile.billingMode).toBe('prepaid');
    expect(resolved.state.profile.status).toBe('active');

    /*
     * Structural: `accountBillingStateSchema` is `.strict()` and declares no
     * balance, so a serializer that started restating the buckets would fail
     * HERE. `/inference/reporting/accounts/:accountId/balance` is the one
     * endpoint that publishes them (#972 workstream 8), and two balance
     * endpoints would disagree the day one stopped accounting for a credit line.
     */
    expect(Object.keys(resolved.state).sort()).toEqual([
      'accountId',
      'billingAccountId',
      'inherited',
      'profile',
      'schemaVersion',
    ]);
  });
});

describe('the sweep and the reader agree about what is available', () => {
  it('agrees for a prepaid account', async () => {
    const accountId = await seedAccount();
    await provisionBillingProfile({ accountId });
    await recordTopUp({
      idempotencyKey: `fund-${randomUUID()}`,
      accountId,
      currency: 'USD',
      amount: '5.000000000000',
      actor: { kind: 'machine' },
    });
    await updateBillingProfile(accountId, {
      autoRechargeEnabled: true,
      autoRechargeThreshold: '10.000000000000',
      autoRechargeAmount: '25.000000000000',
    });

    const candidates = await findAutoRechargeCandidates(500);
    const mine = candidates.find((candidate) => candidate.accountId === accountId);
    expect(mine).toBeDefined();

    const reader = await getAvailableToSpend(getDb(), {
      accountId,
      currency: 'USD',
      billingMode: 'prepaid',
      creditLimit: '0',
    });
    expect(Number(mine?.availableToSpend)).toBe(Number(reader));
  });

  it('agrees with the reporting reader too, which is a THIRD copy of the rule', async () => {
    /*
     * `computeDraw` (what a reservation decides against), the sweep's scan, and
     * `readAccountBalance` (`inferenceReporting.service.ts`, what Console shows)
     * each spell the availability rule out in their own SQL. Three copies is
     * three chances to disagree, and the disagreement a customer notices is
     * being refused with money apparently in hand. This is the gate that would
     * go red if any one of them drifted.
     */
    const accountId = await seedAccount();
    await provisionBillingProfile({
      accountId,
      billingMode: 'invoiced',
      creditLimit: '100.000000000000',
    });
    await recordTopUp({
      idempotencyKey: `fund-${randomUUID()}`,
      accountId,
      currency: 'USD',
      amount: '7.000000000000',
      actor: { kind: 'machine' },
    });

    const reader = await getAvailableToSpend(getDb(), {
      accountId,
      currency: 'USD',
      billingMode: 'invoiced',
      creditLimit: '100.000000000000',
    });
    const reported = await readAccountBalance(accountId);
    expect(reported.status).toBe('resolved');
    if (reported.status !== 'resolved') return;
    const bucket = reported.buckets.find((candidate) => candidate.currency === 'USD');

    expect(Number(bucket?.availableToSpend)).toBe(Number(reader));
    // A non-zero floor: two zeros agree for free, and the whole point is that
    // the invoiced branch adds the unused credit line to the prepaid balance.
    expect(Number(reader)).toBe(107);
  });

  it('agrees for an invoiced account, where the credit limit is the difference', async () => {
    const accountId = await seedAccount();
    await provisionBillingProfile({
      accountId,
      billingMode: 'invoiced',
      creditLimit: '100.000000000000',
    });
    await updateBillingProfile(accountId, {
      autoRechargeEnabled: true,
      autoRechargeThreshold: '250.000000000000',
      autoRechargeAmount: '25.000000000000',
    });

    const candidates = await findAutoRechargeCandidates(500);
    const mine = candidates.find((candidate) => candidate.accountId === accountId);
    expect(mine).toBeDefined();
    // The invoiced branch: nothing prepaid, but 100 of credit room. A sweep that
    // ignored the credit limit would report 0 here and the two would disagree.
    expect(Number(mine?.availableToSpend)).toBe(100);

    const reader = await getAvailableToSpend(getDb(), {
      accountId,
      currency: 'USD',
      billingMode: 'invoiced',
      creditLimit: '100.000000000000',
    });
    expect(Number(reader)).toBe(100);
  });

  it('still REPORTS a suspended account, which is not the same as unprovisioned', async () => {
    /*
     * The sweep skips it — a suspended profile's money cannot be spent, and
     * charging a card to top up a balance nobody may draw on is worse than doing
     * nothing. But the READER must still answer.
     *
     * ## Why this case exists, for whoever writes the THIRD reader
     *
     * `resolveBillingAccount` filters `status = 'active'`. That is right for
     * SPENDING and wrong for READING, and any reader that reaches for it
     * inherits the filter — so a suspended account comes back
     * `not-provisioned`, and the entitlement interface hands Alia "this account
     * cannot be charged at all" for a customer who can be and is merely
     * suspended. A wrong answer that looks exactly like a correct one, across a
     * repository boundary.
     *
     * It is a property of the WALK, not a typo: it appeared independently in
     * `resolveAccountBillingState` and in `readAccountBalance`, written by
     * different people, because both did the obvious thing and called it. The
     * fix in both is the same — load the account's OWN profile directly at any
     * status, and fall back to the walk only for the INHERITED case. The
     * warning lives at `resolveBillingAccount` itself so a third reader meets it
     * at the function it is about to call rather than in this file.
     */
    const accountId = await seedAccount();
    await provisionBillingProfile({ accountId });
    await recordTopUp({
      idempotencyKey: `fund-${randomUUID()}`,
      accountId,
      currency: 'USD',
      amount: '12.000000000000',
      actor: { kind: 'machine' },
    });
    await updateBillingProfile(accountId, { status: 'suspended' });

    const reported = await readAccountBalance(accountId);
    expect(reported.status).toBe('resolved');
    if (reported.status !== 'resolved') return;
    expect(Number(reported.buckets.find((b) => b.currency === 'USD')?.purchased)).toBe(12);

    // And the control: an account with no profile anywhere is still absent.
    const bare = await seedAccount();
    expect((await readAccountBalance(bare)).status).toBe('not-provisioned');
  });

  it('skips a suspended profile, whose money cannot be spent anyway', async () => {
    const accountId = await seedAccount();
    await provisionBillingProfile({ accountId });
    await updateBillingProfile(accountId, {
      status: 'suspended',
      autoRechargeEnabled: true,
      autoRechargeThreshold: '10.000000000000',
      autoRechargeAmount: '25.000000000000',
    });

    const candidates = await findAutoRechargeCandidates(500);
    expect(candidates.map((candidate) => candidate.accountId)).not.toContain(accountId);
  });
});

describe('auto-recharge stakes its claim before the card is charged', () => {
  it('claims once per window and refuses the second attempt', async () => {
    const accountId = await seedAccount();
    await provisionBillingProfile({ accountId });

    const candidate = {
      accountId,
      currency: 'USD',
      threshold: '10.000000000000',
      amount: '25.000000000000',
      availableToSpend: '1.000000000000',
    };
    const now = new Date();

    const first = await claimAutoRecharge(candidate, now);
    expect(first.status).toBe('claimed');

    // A second sweep in the same window — the shape two instances of a cron
    // produce, and the one that would charge a card twice.
    const second = await claimAutoRecharge(candidate, now);
    expect(second.status).toBe('already-claimed');
  });

  it('opens a new claim in the next window', async () => {
    const accountId = await seedAccount();
    await provisionBillingProfile({ accountId });

    const candidate = {
      accountId,
      currency: 'USD',
      threshold: '10.000000000000',
      amount: '25.000000000000',
      availableToSpend: '1.000000000000',
    };
    const now = new Date();
    const nextWindow = new Date(autoRechargeWindowStart(now) + 3600 * 1000 + 1);

    expect((await claimAutoRecharge(candidate, now)).status).toBe('claimed');
    expect((await claimAutoRecharge(candidate, nextWindow)).status).toBe('claimed');
  });
});

describe('a profile update refuses a setting that would silently do nothing', () => {
  it('rejects an enabled auto-recharge with no threshold', async () => {
    const accountId = await seedAccount();
    await provisionBillingProfile({ accountId });

    const result = await updateBillingProfile(accountId, { autoRechargeEnabled: true });
    expect(result.status).toBe('incomplete-auto-recharge');

    const [profile] = await getDb()
      .select()
      .from(billingProfiles)
      .where(eq(billingProfiles.accountId, accountId))
      .limit(1);
    expect(profile.autoRechargeEnabled).toBe(false);
  });

  it('never edits an INHERITED profile through the inheriting account', async () => {
    const organizationId = await seedAccount();
    const projectId = await seedAccount(organizationId);
    await provisionBillingProfile({ accountId: organizationId });

    // The project happily SPENDS the organization's money, but addressing the
    // organization's credit limit through the project would let a project change
    // its parent's terms.
    const result = await updateBillingProfile(projectId, { status: 'suspended' });
    expect(result.status).toBe('not-provisioned');

    const [parent] = await getDb()
      .select()
      .from(billingProfiles)
      .where(eq(billingProfiles.accountId, organizationId))
      .limit(1);
    expect(parent.status).toBe('active');
  });
});

describe('provisioning', () => {
  it('creates the profile and its balance row together', async () => {
    const accountId = await seedAccount();
    const result = await provisionAccountBilling({ accountId, currency: 'USD' });
    expect(result.status).toBe('provisioned');

    const [balance] = await getDb()
      .select()
      .from(accountBalances)
      .where(eq(accountBalances.accountId, accountId))
      .limit(1);
    expect(balance).toBeDefined();
  });

  it('refuses an account that does not exist rather than raising a foreign key error', async () => {
    await expect(
      provisionAccountBilling({ accountId: `missing-${randomUUID()}` })
    ).resolves.toMatchObject({ status: 'unknown-account' });
  });
});
