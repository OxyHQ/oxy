/**
 * Payment / wallet / subscription domain types.
 *
 * These model the JSON shapes the Oxy API actually returns for the
 * payment-related read endpoints, so the corresponding query hooks
 * (`useUserSubscription`, `useUserPayments`, `useUserWallet`,
 * `useUserWalletTransactions`) expose precise types instead of `any`.
 *
 * Source of truth (API):
 *  - Subscription:  GET /subscription/:userId   -> billing-first normalized
 *                   subscription JSON (Stripe `BillingSubscription` with legacy
 *                   `Subscription` fallback), or `{ plan: 'basic' }` when none.
 *  - Payments:      GET /payments/user          -> `Payment[]` (sendSuccess).
 *  - Wallet:        GET /wallet/:userId         -> `Wallet` (sendSuccess).
 *  - Transactions:  GET /wallet/transactions/:userId
 *                   -> `WalletTransactionsResponse` (sendPaginated envelope).
 *
 * All `Date` columns are serialized as ISO-8601 strings over the wire.
 *
 * Note: `@oxyhq/services` deliberately does NOT re-export these from
 * `@oxyhq/core`. They live here because they describe the return shape of
 * the services-layer query hooks; consumers that need core domain types
 * import those directly from `@oxyhq/core`.
 */

/** Subscription tier. Mirrors the `plan` enum on the API `Subscription` model. */
export type SubscriptionPlan = 'basic' | 'pro' | 'business';

/** Lifecycle state of a subscription. */
export type SubscriptionStatus = 'active' | 'canceled' | 'expired';

/** Feature flags toggled by the active subscription plan. */
export interface SubscriptionFeatures {
  analytics: boolean;
  premiumBadge: boolean;
  unlimitedFollowing: boolean;
  higherUploadLimits: boolean;
  promotedPosts: boolean;
  businessTools: boolean;
}

/**
 * A user's subscription.
 *
 * When a user has never subscribed, the API returns the minimal fallback
 * `{ plan: 'basic' }`; every other field is therefore optional so the type
 * covers both the persisted document and the fallback.
 */
export interface Subscription {
  plan: SubscriptionPlan;
  status?: SubscriptionStatus;
  /** Account this subscription belongs to (absent on the basic fallback). */
  userId?: string;
  /** ISO-8601 timestamp the current period started. */
  startDate?: string;
  /** ISO-8601 timestamp the current period ends / renews. */
  endDate?: string;
  autoRenew?: boolean;
  paymentMethod?: string;
  latestInvoice?: string;
  features?: SubscriptionFeatures;
  /** ISO-8601 creation timestamp. */
  createdAt?: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt?: string;
}

/**
 * A billing / payment history entry, derived from `deposit` and `purchase`
 * transactions on the API side (`GET /payments/user`).
 */
export interface Payment {
  id: string;
  userId: string;
  type: string;
  amount: number;
  status: string;
  description?: string;
  itemId?: string;
  itemType?: string;
  /** ISO-8601 timestamp the payment was created (maps to `createdAt`). */
  timestamp?: string;
  /** ISO-8601 timestamp the payment settled, when applicable. */
  completedAt?: string;
}

/** FairCoin wallet balance for a user (`GET /wallet/:userId`). */
export interface Wallet {
  userId: string;
  balance: number;
  /** On-chain withdrawal address, `null` until one is set. */
  address: string | null;
}

/** Direction/category of a wallet transaction. */
export type WalletTransactionType = 'deposit' | 'withdrawal' | 'transfer' | 'purchase';

/** Settlement state of a wallet transaction. */
export type WalletTransactionStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

/**
 * A single wallet ledger entry returned by the transaction-history endpoint.
 *
 * The populated `userId` / `recipientId` may arrive either as a bare id
 * string or as a `{ _id, username }` object depending on Mongoose
 * population, so both shapes are modelled.
 */
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
  /** ISO-8601 creation timestamp (maps to `createdAt`). */
  timestamp?: string;
  /** ISO-8601 settlement timestamp, when applicable. */
  completedAt?: string;
}

/** Pagination metadata attached to a paginated list response. */
export interface WalletPagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Paginated envelope returned by `GET /wallet/transactions/:userId`.
 *
 * The HTTP layer preserves the `{ data, pagination }` shape for paginated
 * responses (it only unwraps the plain `{ data }` success envelope), so
 * callers receive the list under `data`.
 */
export interface WalletTransactionsResponse {
  data: WalletTransaction[];
  pagination: WalletPagination;
}
