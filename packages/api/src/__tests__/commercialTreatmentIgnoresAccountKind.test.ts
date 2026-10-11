/**
 * Commercial treatment never derives from an account's KIND (issue #1520, I01).
 *
 * A bot and a person with the same plan get the same commercial treatment: no
 * exemption, surcharge, gate or approval may follow from `kind`. The modules
 * below decide plans, entitlements, balances, reservations, charges, receipts and
 * spending limits — `KIND_INDEPENDENT_ACCOUNT_DIMENSIONS` in
 * `@oxy.so/contracts` — and today none of them reads `users.kind`. This keeps it
 * that way structurally: a `kind === 'bot'` branch added to one of them still
 * compiles and still passes every behavioural test that does not happen to use a
 * bot, so a comment would not be a control.
 *
 * The behavioural half (same top-up, same reservation, same receipt for a bot
 * and a person) is `services/__tests__/botAccountParity.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIND_INDEPENDENT_ACCOUNT_DIMENSIONS } from '@oxy.so/contracts';

const SRC = join(__dirname, '..');

/** Modules that decide a kind-independent dimension, and which one. */
const COMMERCIAL_MODULES: ReadonlyMap<string, string> = new Map([
  ['services/entitlement.service.ts', 'plan, allowances'],
  ['services/accountBilling.service.ts', 'payer, billing terms'],
  ['services/inferenceLedger.service.ts', 'balance, reservation, receipt'],
  ['services/spendingLimit.service.ts', 'spending limits'],
  ['services/stripeAccountBilling.service.ts', 'funding'],
  ['services/billingReconciliation.service.ts', 'reconciliation'],
  ['utils/subscriptionPlan.ts', 'plan'],
  ['routes/accountBilling.ts', 'billing surface'],
  ['routes/billing.ts', 'subscriptions'],
]);

/**
 * Reads of the account-kind column or vocabulary. `kind` alone is not banned —
 * these modules legitimately carry other discriminants named `kind` (a ledger
 * actor's, a principal's) — so the scan names the account-kind sources.
 */
const ACCOUNT_KIND_READS = [
  'users.kind',
  'AccountKind',
  'ACCOUNT_KINDS',
  "kind === 'bot'",
  "kind !== 'bot'",
  "kind === 'personal'",
  "kind !== 'personal'",
  'isDelegatedActAsEligibleKind',
  'isOperatorSwitchTargetKind',
  'accountKindActorNature',
  'accountKindActsAsItself',
] as const;

/** Code only: a comment naming the rule is not a breach of it. */
function codeOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

describe('commercial modules never read the account kind', () => {
  it('covers the dimensions the contract declares kind-independent', () => {
    expect([...KIND_INDEPENDENT_ACCOUNT_DIMENSIONS]).toEqual(
      expect.arrayContaining(['plan', 'balance', 'payer', 'beneficiary']),
    );
  });

  it.each([...COMMERCIAL_MODULES.entries()])('%s (%s)', (path, decides) => {
    const code = codeOf(readFileSync(join(SRC, path), 'utf8'));
    const found = ACCOUNT_KIND_READS.filter((needle) => code.includes(needle));

    expect({ path, decides, found }).toEqual({ path, decides, found: [] });
  });

  /**
   * Positive control: every assertion above passes if a file has been emptied
   * by `codeOf` or renamed into a stub. Each module must still contain real
   * code that touches an account id.
   */
  it.each([...COMMERCIAL_MODULES.keys()])('%s is a real module the scan reads', (path) => {
    const code = codeOf(readFileSync(join(SRC, path), 'utf8'));

    expect(code.length).toBeGreaterThan(500);
    expect(code).toMatch(/accountId|userId/);
  });
});
