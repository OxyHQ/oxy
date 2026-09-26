/**
 * `oxy.reputation` — Oxy Trust reputation, read-only.
 *
 * People only READ reputation here. Points come from the applications that
 * observed an action (`OxyServer.reputation.award`, service token), under rules
 * fixed in code. Nobody — staff included — edits a person's standing by hand.
 *
 * Every type is owned by `@oxy.so/contracts`; import them from there.
 */
import type {
  ReputationBalance,
  ReputationBalanceView,
  ReputationInfluenceContext,
  ReputationInfluenceResult,
  ReputationLeaderboardEntry,
  ReputationRule,
  ReputationTransaction,
} from '@oxy.so/contracts';
import { isFullReputationBalance } from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';
import { OxyAuthenticationError } from '../OxyServices.errors';

const SHORT = 60 * 1000;
const MEDIUM = 2 * 60 * 1000;
const LONG = 5 * 60 * 1000;
const EXTRA_LONG = 30 * 60 * 1000;

/** Cache-key prefix of every cached `GET /reputation/...` response. */
export const REPUTATION_CACHE_PREFIX = 'GET:/reputation/';

export interface ReputationPage {
  limit?: number;
  offset?: number;
}

export class ReputationApi {
  constructor(protected readonly ctx: OxyContext) {}

  /**
   * The SIGNED-IN user's balance, in full (`breakdown`, `influence`,
   * `reliability`). Throws when not signed in, or when the server answered with
   * the public view (the request was not authenticated as the subject).
   */
  balance(): Promise<ReputationBalance>;
  /**
   * ANY user's balance, in whichever view the server serves the caller: a third
   * party gets only `userId`, `total` and `trustTier`. Narrow with
   * `isFullReputationBalance` before reading the private blocks.
   * @param userId - The subject's `_id` or publicKey.
   */
  balance(userId: string): Promise<ReputationBalanceView>;
  async balance(userId?: string): Promise<ReputationBalanceView> {
    const mine = !userId;
    const id = userId || this.ctx.oxy.session.userId;
    if (!id) {
      throw new OxyAuthenticationError('Reading your own reputation balance requires a signed-in user');
    }
    const balance = await this.ctx.request<ReputationBalanceView>(
      'GET',
      `/reputation/${encodeURIComponent(id)}/balance`,
      undefined,
      { cache: true, cacheTTL: MEDIUM },
    );
    if (mine && !isFullReputationBalance(balance)) {
      throw new OxyAuthenticationError(
        'The reputation balance came back as the public view — the request was not authenticated as its subject',
      );
    }
    return balance;
  }

  /** The leaderboard, by lifetime total, descending. */
  async leaderboard(page: ReputationPage = {}): Promise<ReputationLeaderboardEntry[]> {
    const res = await this.ctx.request<{ data?: ReputationLeaderboardEntry[] }>(
      'GET',
      '/reputation/leaderboard',
      pageParams(page),
      { cache: true, cacheTTL: LONG },
    );
    return res.data ?? [];
  }

  /** The enabled rules: what earns and what costs reputation. */
  async rules(): Promise<ReputationRule[]> {
    const res = await this.ctx.request<{ rules?: ReputationRule[] }>('GET', '/reputation/rules', undefined, {
      cache: true,
      cacheTTL: EXTRA_LONG,
    });
    return res.rules ?? [];
  }

  /**
   * A user's ledger, newest first (default: the signed-in user's). Auth required.
   * @param userId - The subject's `_id` or publicKey.
   */
  async transactions(userId?: string, page: ReputationPage = {}): Promise<ReputationTransaction[]> {
    const id = this.resolveUserId(userId);
    const res = await this.ctx.request<{ data?: ReputationTransaction[] }>(
      'GET',
      `/reputation/${encodeURIComponent(id)}/transactions`,
      pageParams(page),
      { cache: true, cacheTTL: SHORT },
    );
    return res.data ?? [];
  }

  /**
   * A user's capped influence weight for one context (default: the signed-in
   * user's). Auth required.
   * @param context - The weight axis (server default: `default`).
   */
  async influence(userId?: string, context?: ReputationInfluenceContext): Promise<ReputationInfluenceResult> {
    const id = this.resolveUserId(userId);
    return this.ctx.request<ReputationInfluenceResult>(
      'GET',
      `/reputation/${encodeURIComponent(id)}/influence`,
      context ? { context } : undefined,
      { cache: true, cacheTTL: MEDIUM },
    );
  }

  protected resolveUserId(userId?: string): string {
    const id = userId || this.ctx.oxy.session.userId;
    if (!id) throw new OxyAuthenticationError('A user id is required (none given and not signed in)');
    return id;
  }
}

function pageParams(page: ReputationPage): Record<string, number> | undefined {
  const params: Record<string, number> = {};
  if (page.limit !== undefined) params.limit = page.limit;
  if (page.offset !== undefined) params.offset = page.offset;
  return Object.keys(params).length > 0 ? params : undefined;
}
