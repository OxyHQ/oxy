/**
 * The signed-in account's Oxy Trust standing, held in its `@oxy.so/bloom-data`
 * store: its balance with its latest ledger entries, its balance alone, and
 * the rules that earn and cost reputation. Memory only, as their queries were.
 *
 * Standing and balance are kept by the account's id (the org, project or bot
 * when switched, else the person), because their reads name it.
 */
import { entity, source } from '@oxy.so/bloom-data';
import type {
  ReputationBalanceView,
  ReputationRule,
  ReputationTransaction,
} from '@oxy.so/contracts';
import type { OxyServices } from '@oxy.so/core';
import { ACCOUNT_VALUE, accountValue } from './accountValue';
import { sdkRead } from './readOptions';

/** The SDK's default for a read that named no staleness of its own. */
const TRUST_STALE_MS = 5 * 60_000;
const TRUST_GC_MS = 30 * 60_000;
/** Ledger entries the Trust Center shows. */
export const TRUST_LEDGER_LIMIT = 20;

export interface TrustStandingRecord {
  readonly userId: string;
  readonly balance: ReputationBalanceView;
  readonly transactions: readonly ReputationTransaction[];
}

export const TrustStanding = entity<TrustStandingRecord>('oxy.trust-standing', {
  id: (standing) => standing.userId,
});

/** The account's balance and its latest ledger entries, read together. */
export const trustStanding = source(TrustStanding, {
  ...sdkRead,
  key: (_oxy: OxyServices, userId: string) => userId,
  stale: TRUST_STALE_MS,
  gcTime: TRUST_GC_MS,
  load: async (_request, oxy, userId) => {
    const [balance, transactions] = await Promise.all([
      oxy.reputation.balance(),
      oxy.reputation.transactions(userId, { limit: TRUST_LEDGER_LIMIT, offset: 0 }),
    ]);
    return { userId, balance, transactions: Array.isArray(transactions) ? transactions : [] };
  },
});

export interface ReputationBalanceRecord {
  readonly userId: string;
  readonly balance: ReputationBalanceView;
}

export const ReputationBalance = entity<ReputationBalanceRecord>('oxy.reputation-balance', {
  id: (held) => held.userId,
});

/** The account's balance alone. */
export const reputationBalance = source(ReputationBalance, {
  ...sdkRead,
  key: (_oxy: OxyServices, userId: string) => userId,
  stale: TRUST_STALE_MS,
  gcTime: TRUST_GC_MS,
  load: async (_request, oxy, userId) => ({ userId, balance: await oxy.reputation.balance() }),
});

export interface ReputationRulesRecord {
  readonly rules: readonly ReputationRule[];
}

export const ReputationRules = accountValue<ReputationRulesRecord>('oxy.reputation-rules');

/** The enabled rules: what earns and what costs reputation. */
export const reputationRules = source(ReputationRules, {
  ...sdkRead,
  key: (_oxy: OxyServices) => ACCOUNT_VALUE,
  stale: 10 * 60_000,
  gcTime: TRUST_GC_MS,
  load: async (_request, oxy) => ({ rules: await oxy.reputation.rules() }),
});
