/**
 * `oxy.billing` — the signed-in user's subscription, wallet and payment history.
 *
 * Every call reads the SIGNED-IN user's data unless a `userId` is passed (the
 * API refuses any other user's). Checkout, plan changes and cancellation live
 * under `/billing` (Stripe) and are not wrapped here yet.
 *
 * The types model the JSON these routes actually return (`subscription.controller`,
 * `payment.controller`, `wallet.routes` in `packages/api`); `Date` columns
 * arrive as ISO-8601 strings.
 */
import type { OxyContext } from '../client/context';

const SUBSCRIPTION_TTL = 2 * 60 * 1000;
const WALLET_TTL = 60 * 1000;

/** Subscription tier. */
export type SubscriptionPlan = 'basic' | 'pro' | 'business';

/** Lifecycle state of a subscription. */
export type SubscriptionStatus = 'active' | 'canceled' | 'expired';

/** Feature flags toggled by the active plan. */
export interface SubscriptionFeatures {
  analytics: boolean;
  premiumBadge: boolean;
  unlimitedFollowing: boolean;
  higherUploadLimits: boolean;
  promotedPosts: boolean;
  businessTools: boolean;
}

/**
 * A user's subscription. A user who never subscribed gets `{ plan: 'basic' }`,
 * so every other field is optional.
 */
export interface Subscription {
  plan: SubscriptionPlan;
  status?: SubscriptionStatus;
  userId?: string;
  startDate?: string;
  endDate?: string;
  autoRenew?: boolean;
  paymentMethod?: string;
  latestInvoice?: string;
  features?: SubscriptionFeatures;
  createdAt?: string;
  updatedAt?: string;
}

/** A payment history entry (a `deposit` or `purchase` transaction). */
export interface Payment {
  id: string;
  userId: string;
  type: string;
  amount: number;
  status: string;
  description?: string;
  itemId?: string;
  itemType?: string;
  /** When the payment was created. */
  timestamp?: string;
  completedAt?: string;
}

/** A user's FairCoin wallet. */
export interface Wallet {
  userId: string;
  balance: number;
  /** On-chain withdrawal address, `null` until one is set. */
  address: string | null;
}

export type WalletTransactionType = 'deposit' | 'withdrawal' | 'transfer' | 'purchase';
export type WalletTransactionStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

/** One wallet ledger entry. */
export interface WalletTransaction {
  id: string;
  userId: string | { _id: string; username?: string };
  type: WalletTransactionType;
  amount: number;
  status: WalletTransactionStatus;
  description?: string;
  recipientId?: string | { _id: string; username?: string } | null;
  itemId?: string;
  itemType?: string;
  timestamp?: string;
  completedAt?: string;
}

export interface WalletPagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** A page of wallet transactions. */
export interface WalletTransactionsPage {
  data: WalletTransaction[];
  pagination: WalletPagination;
}

export class BillingApi {
  constructor(protected readonly ctx: OxyContext) {}

  /** The signed-in user's payment history. Never cached. */
  async payments(): Promise<Payment[]> {
    return this.ctx.request<Payment[]>('GET', '/payments/user', undefined, { cache: false });
  }

  /** A user's subscription (default: the signed-in user's). */
  async subscription(userId?: string): Promise<Subscription> {
    const id = this.resolveUserId(userId);
    return this.ctx.request<Subscription>('GET', `/subscription/${id}`, undefined, {
      cache: true,
      cacheTTL: SUBSCRIPTION_TTL,
    });
  }

  /** A user's wallet (default: the signed-in user's). Cached briefly: the balance moves. */
  async wallet(userId?: string): Promise<Wallet> {
    const id = this.resolveUserId(userId);
    return this.ctx.request<Wallet>('GET', `/wallet/${id}`, undefined, { cache: true, cacheTTL: WALLET_TTL });
  }

  /** A page of a user's wallet transactions (default: the signed-in user's). Never cached. */
  async walletTransactions(
    options: { userId?: string; limit?: number; offset?: number } = {},
  ): Promise<WalletTransactionsPage> {
    const id = this.resolveUserId(options.userId);
    const params: Record<string, number> = {};
    if (options.limit) params.limit = options.limit;
    if (options.offset) params.offset = options.offset;
    return this.ctx.request<WalletTransactionsPage>('GET', `/wallet/transactions/${id}`, params, { cache: false });
  }

  private resolveUserId(userId?: string): string {
    const id = userId || this.ctx.oxy.session.userId;
    if (!id) throw new Error('User not authenticated');
    return id;
  }
}
