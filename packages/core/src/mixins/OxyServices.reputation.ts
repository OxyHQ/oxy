/**
 * Reputation Methods Mixin (Oxy Trust)
 *
 * Provides typed access to the reputation ledger (#217) and the derived
 * trust-tier / capped-influence model (#219) via the `/reputation` API.
 *
 * The reputation ledger is append-only: transactions are NEVER deleted.
 * A correction is expressed either as a compensating REVERSAL (the original is
 * marked `reversed` and a new `active` transaction with negated points is
 * appended) or a VOID (the original is marked `voided` and excluded from the
 * balance). A user's `ReputationBalance` is a recomputable cache of the sum of
 * their `active` transactions, augmented with a trust tier, capped influence
 * weights, and reliability signals.
 *
 * A balance is served in TWO views (see `ReputationBalanceView`): the subject
 * and platform staff get the whole thing, a third party gets the public trust
 * signal only. The two are distinct types so a caller cannot read a field the
 * server did not send them.
 *
 * EVERY type on this surface is owned by `@oxyhq/contracts`, which the API's
 * serializers are annotated and validated against. This mixin declares none of
 * them and re-exports none of them: consumers import the types straight from
 * `@oxyhq/contracts`, so the wire shape has exactly one definition and a
 * server-side change to a serializer cannot compile while the type still
 * promises the old shape.
 *
 * Reference users by their Mongo `_id` (or publicKey, which the API resolves),
 * transactions by their `id`, and disputes by their `id`.
 */
import type {
  AwardReputationInput,
  CreateReputationDisputeInput,
  ReputationBalance,
  ReputationBalanceView,
  ReputationDispute,
  ReputationInfluenceContext,
  ReputationInfluenceResult,
  ReputationLeaderboardEntry,
  ReputationRule,
  ReputationTransaction,
  ResolveReputationDisputeInput,
  ReverseReputationTransactionInput,
  ReverseReputationTransactionResult,
  UpsertReputationRuleInput,
} from '@oxyhq/contracts';
import { isFullReputationBalance } from '@oxyhq/contracts';
import type { OxyServicesBase } from '../OxyServices.base';
import { OxyAuthenticationError } from '../OxyServices.errors';
import { CACHE_TIMES } from './mixinHelpers';

/** Cache-key prefix for every cached `GET /reputation/...` response. */
const REPUTATION_CACHE_PREFIX = 'GET:/reputation/';

export function OxyServicesReputationMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    /**
     * Get ANY user's reputation balance, in whichever view the server serves the
     * caller.
     *
     * A third party gets `userId`, `total` and `trustTier` and nothing else, so
     * the return type is a {@link ReputationBalanceView} union: narrow it with
     * {@link isFullReputationBalance} before touching `breakdown`, `influence`
     * or `reliability`. To read your OWN balance, call
     * {@link getMyReputationBalance} instead — it returns the full shape with no
     * narrowing.
     *
     * @param userId - The subject user's `_id` or publicKey.
     */
    async getReputationBalance(userId: string): Promise<ReputationBalanceView> {
      try {
        return await this.makeRequest<ReputationBalanceView>(
          'GET',
          `/reputation/${encodeURIComponent(userId)}/balance`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.MEDIUM },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get the SIGNED-IN user's own reputation balance, in full.
     *
     * The subject view is the only one carrying `breakdown`, `influence` and
     * `reliability`, and the subject is the common caller, so this is the
     * ergonomic path: no id to pass, no narrowing to do.
     *
     * Throws rather than returning a half-populated object when the request was
     * not authenticated as the subject — with no signed-in user, and when the
     * server answered `200` with the public view anyway (which it does for an
     * absent or lapsed token, since the endpoint's auth is optional). Both mean
     * the private blocks are simply absent, and a thrown error is the only
     * honest report of that.
     */
    async getMyReputationBalance(): Promise<ReputationBalance> {
      const userId = this.getCurrentUserId();
      if (!userId) {
        throw new OxyAuthenticationError(
          'Reading your own reputation balance requires a signed-in user',
        );
      }

      let balance: ReputationBalanceView;
      try {
        balance = await this.makeRequest<ReputationBalanceView>(
          'GET',
          `/reputation/${encodeURIComponent(userId)}/balance`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.MEDIUM },
        );
      } catch (error) {
        throw this.handleError(error);
      }

      if (!isFullReputationBalance(balance)) {
        throw new OxyAuthenticationError(
          'The reputation balance came back as the public view — the request was not authenticated as its subject',
        );
      }
      return balance;
    }

    /**
     * Get the reputation leaderboard, ordered by lifetime total descending.
     * @param limit - Page size (server-capped).
     * @param offset - Page offset.
     */
    async getReputationLeaderboard(
      limit?: number,
      offset?: number,
    ): Promise<ReputationLeaderboardEntry[]> {
      try {
        const params: { limit?: number; offset?: number } = {};
        if (limit !== undefined) params.limit = limit;
        if (offset !== undefined) params.offset = offset;
        const res = await this.makeRequest<{ data?: ReputationLeaderboardEntry[] }>(
          'GET',
          '/reputation/leaderboard',
          Object.keys(params).length > 0 ? params : undefined,
          { cache: true, cacheTTL: CACHE_TIMES.LONG },
        );
        return res.data ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * List the enabled reputation rules (for client display).
     */
    async getReputationRules(): Promise<ReputationRule[]> {
      try {
        const res = await this.makeRequest<{ rules?: ReputationRule[] }>(
          'GET',
          '/reputation/rules',
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.EXTRA_LONG },
        );
        return res.rules ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get a user's paginated reputation ledger, newest first (auth required).
     * @param userId - The subject user's `_id` or publicKey.
     * @param limit - Page size (server-capped).
     * @param offset - Page offset.
     */
    async getReputationTransactions(
      userId: string,
      limit?: number,
      offset?: number,
    ): Promise<ReputationTransaction[]> {
      try {
        const params: { limit?: number; offset?: number } = {};
        if (limit !== undefined) params.limit = limit;
        if (offset !== undefined) params.offset = offset;
        const res = await this.makeRequest<{ data?: ReputationTransaction[] }>(
          'GET',
          `/reputation/${encodeURIComponent(userId)}/transactions`,
          Object.keys(params).length > 0 ? params : undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return res.data ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get a user's capped influence weight for a given context (auth required).
     * @param userId - The subject user's `_id` or publicKey.
     * @param context - The weight axis to read (defaults server-side to `default`).
     */
    async getReputationInfluence(
      userId: string,
      context?: ReputationInfluenceContext,
    ): Promise<ReputationInfluenceResult> {
      try {
        return await this.makeRequest<ReputationInfluenceResult>(
          'GET',
          `/reputation/${encodeURIComponent(userId)}/influence`,
          context ? { context } : undefined,
          { cache: true, cacheTTL: CACHE_TIMES.MEDIUM },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Award (or penalise) reputation to a user by `actionType`. Restricted to
     * service tokens and platform staff. Invalidates cached reputation reads.
     * @param input - The award payload (subject, action, source, target, etc.).
     */
    async awardReputation(input: AwardReputationInput): Promise<ReputationTransaction> {
      try {
        const res = await this.makeRequest<{ transaction: ReputationTransaction }>(
          'POST',
          '/reputation/award',
          input,
          { cache: false },
        );
        this.clearCacheByPrefix(REPUTATION_CACHE_PREFIX);
        return res.transaction;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Open a dispute against a transaction (auth required; the disputer is the
     * authenticated user and must own the transaction).
     * @param input - The transaction id, reason, and optional evidence.
     */
    async createReputationDispute(
      input: CreateReputationDisputeInput,
    ): Promise<ReputationDispute> {
      try {
        const res = await this.makeRequest<{ dispute: ReputationDispute }>(
          'POST',
          '/reputation/disputes',
          input,
          { cache: false },
        );
        this.clearCacheByPrefix(REPUTATION_CACHE_PREFIX);
        return res.dispute;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * List a user's own reputation disputes (auth required; the caller must be
     * the subject or platform staff).
     * @param userId - The subject user's `_id` or publicKey.
     * @param limit - Page size (server-capped).
     * @param offset - Page offset.
     */
    async getUserReputationDisputes(
      userId: string,
      limit?: number,
      offset?: number,
    ): Promise<ReputationDispute[]> {
      try {
        const params: { limit?: number; offset?: number } = {};
        if (limit !== undefined) params.limit = limit;
        if (offset !== undefined) params.offset = offset;
        const res = await this.makeRequest<{ data?: ReputationDispute[] }>(
          'GET',
          `/reputation/${encodeURIComponent(userId)}/disputes`,
          Object.keys(params).length > 0 ? params : undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return res.data ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    // =========================================================================
    // STAFF / ADMIN METHODS (require staff privileges server-side)
    // =========================================================================

    /**
     * Create or update a reputation rule, keyed by `actionType` (staff only).
     * Invalidates the cached rule list.
     * @param input - The rule definition.
     */
    async upsertReputationRule(input: UpsertReputationRuleInput): Promise<ReputationRule> {
      try {
        const res = await this.makeRequest<{ rule: ReputationRule }>(
          'POST',
          '/reputation/rules',
          input,
          { cache: false },
        );
        this.clearCacheByPrefix(REPUTATION_CACHE_PREFIX);
        return res.rule;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Reverse a transaction (staff only): mark the original `reversed` and append
     * a compensating `active` reversal with negated points. Invalidates cached
     * reputation reads.
     * @param transactionId - The transaction's id.
     * @param input - Optional reason for the reversal.
     */
    async reverseReputationTransaction(
      transactionId: string,
      input?: ReverseReputationTransactionInput,
    ): Promise<ReverseReputationTransactionResult> {
      try {
        const res = await this.makeRequest<ReverseReputationTransactionResult>(
          'POST',
          `/reputation/transactions/${encodeURIComponent(transactionId)}/reverse`,
          input ?? {},
          { cache: false },
        );
        this.clearCacheByPrefix(REPUTATION_CACHE_PREFIX);
        return res;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Void a transaction (staff only): mark it `voided` so it is excluded from
     * the balance, with NO compensating entry. Invalidates cached reputation
     * reads.
     * @param transactionId - The transaction's id.
     * @param input - Optional reason for the void.
     */
    async voidReputationTransaction(
      transactionId: string,
      input?: ReverseReputationTransactionInput,
    ): Promise<ReputationTransaction> {
      try {
        const res = await this.makeRequest<{ transaction: ReputationTransaction }>(
          'POST',
          `/reputation/transactions/${encodeURIComponent(transactionId)}/void`,
          input ?? {},
          { cache: false },
        );
        this.clearCacheByPrefix(REPUTATION_CACHE_PREFIX);
        return res.transaction;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Force a recompute of a user's balance snapshot from their active ledger
     * (staff only). Invalidates cached reputation reads.
     *
     * Staff-gated, so the response is always the full subject view — no
     * narrowing needed.
     *
     * @param userId - The subject user's `_id` or publicKey.
     */
    async recalculateReputation(userId: string): Promise<ReputationBalance> {
      try {
        const res = await this.makeRequest<ReputationBalance>(
          'POST',
          `/reputation/${encodeURIComponent(userId)}/recalculate`,
          undefined,
          { cache: false },
        );
        this.clearCacheByPrefix(REPUTATION_CACHE_PREFIX);
        return res;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get the open dispute queue across all users (staff only).
     * @param limit - Page size (server-capped).
     * @param offset - Page offset.
     */
    async getReputationDisputeQueue(
      limit?: number,
      offset?: number,
    ): Promise<ReputationDispute[]> {
      try {
        const params: { limit?: number; offset?: number } = {};
        if (limit !== undefined) params.limit = limit;
        if (offset !== undefined) params.offset = offset;
        const res = await this.makeRequest<{ data?: ReputationDispute[] }>(
          'GET',
          '/reputation/disputes',
          Object.keys(params).length > 0 ? params : undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return res.data ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Resolve a dispute (staff only). Accepting reverses the disputed
     * transaction; rejecting restores it to `active`. Invalidates cached
     * reputation reads.
     * @param disputeId - The dispute's id.
     * @param input - The resolution (`accepted` or `rejected`).
     */
    async resolveReputationDispute(
      disputeId: string,
      input: ResolveReputationDisputeInput,
    ): Promise<ReputationDispute> {
      try {
        const res = await this.makeRequest<{ dispute: ReputationDispute }>(
          'POST',
          `/reputation/disputes/${encodeURIComponent(disputeId)}/resolve`,
          input,
          { cache: false },
        );
        this.clearCacheByPrefix(REPUTATION_CACHE_PREFIX);
        return res.dispute;
      } catch (error) {
        throw this.handleError(error);
      }
    }
  };
}
