/**
 * Centralized query keys for TanStack Query
 *
 * Following best practices:
 * - Use arrays for hierarchical keys
 * - Include all parameters in the key
 * - Use consistent naming conventions
 */

import type { QueryClient } from '@tanstack/react-query';

export const queryKeys = {
  // Account queries
  accounts: {
    all: ['accounts'] as const,
    lists: () => [...queryKeys.accounts.all, 'list'] as const,
    list: (sessionIds: string[]) => [...queryKeys.accounts.lists(), sessionIds] as const,
    details: () => [...queryKeys.accounts.all, 'detail'] as const,
    detail: (sessionId: string) => [...queryKeys.accounts.details(), sessionId] as const,
    current: (sessionId?: string | null) =>
      sessionId
        ? ([...queryKeys.accounts.all, 'current', sessionId] as const)
        : ([...queryKeys.accounts.all, 'current'] as const),
    settings: () => [...queryKeys.accounts.all, 'settings'] as const,
  },

  // User queries
  users: {
    all: ['users'] as const,
    lists: () => [...queryKeys.users.all, 'list'] as const,
    list: (userIds: string[]) => [...queryKeys.users.lists(), userIds] as const,
    details: () => [...queryKeys.users.all, 'detail'] as const,
    detail: (userId: string) => [...queryKeys.users.details(), userId] as const,
    /** Viewer-scoped single-profile fetch by user id (`relationship` is viewer-relative). */
    detailForViewer: (userId: string, viewerId: string) =>
      [...queryKeys.users.details(), userId, 'viewer', viewerId] as const,
    /**
     * Viewer-scoped single-profile fetch by username (`relationship` is
     * viewer-relative). Username is normalized to `trim().toLowerCase()` here
     * so the hook key and any external seeder (e.g. Mention's precache) agree
     * by construction — normalize once, never at call sites.
     */
    byUsername: (username: string, viewerId: string) =>
      [
        ...queryKeys.users.details(),
        'username',
        username.trim().toLowerCase(),
        'viewer',
        viewerId,
      ] as const,
    profile: (sessionId: string) => [...queryKeys.users.details(), sessionId, 'profile'] as const,
  },

  // Session queries
  sessions: {
    all: ['sessions'] as const,
    lists: () => [...queryKeys.sessions.all, 'list'] as const,
    list: (userId?: string) => [...queryKeys.sessions.lists(), userId] as const,
    details: () => [...queryKeys.sessions.all, 'detail'] as const,
    detail: (sessionId: string) => [...queryKeys.sessions.details(), sessionId] as const,
    active: () => [...queryKeys.sessions.all, 'active'] as const,
    device: (deviceId: string) => [...queryKeys.sessions.all, 'device', deviceId] as const,
  },

  // Privacy settings queries
  privacy: {
    all: ['privacy'] as const,
    settings: (userId?: string) =>
      [...queryKeys.privacy.all, 'settings', userId || 'current'] as const,
    /** The active account's blocked + restricted lists. */
    lists: (userId?: string) => [...queryKeys.privacy.all, 'lists', userId || 'current'] as const,
  },

  // User file library (infinite-paginated; owner-scoped so switching the active
  // account shows that account's files without a manual reset)
  files: {
    all: ['files'] as const,
    list: (ownerId?: string) => [...queryKeys.files.all, 'list', ownerId || 'anonymous'] as const,
    /** The owner's trash (ADR 0043 D5) — under `files.all`, so one invalidation covers both. */
    trash: (ownerId?: string) => [...queryKeys.files.all, 'trash', ownerId || 'anonymous'] as const,
    /**
     * The applications that can read one file with their own token (ADR 0043
     * stage 4c) — under `files.all`, so a library invalidation refreshes it too.
     */
    appAccess: (fileId: string) => [...queryKeys.files.all, 'appAccess', fileId] as const,
  },

  // Connected apps (OAuth grants the user has authorized)
  connectedApps: {
    all: ['connectedApps'] as const,
    list: () => [...queryKeys.connectedApps.all, 'list'] as const,
  },

  // Follow / social graph queries
  follow: {
    all: ['follow'] as const,
    counts: (userId: string) => [...queryKeys.follow.all, 'counts', userId] as const,
  },

  // Payment / wallet / subscription queries
  payments: {
    all: ['payments'] as const,
    subscription: (userId?: string) =>
      [...queryKeys.payments.all, 'subscription', userId || 'current'] as const,
    history: (userId?: string) =>
      [...queryKeys.payments.all, 'history', userId || 'current'] as const,
    wallet: (userId?: string) =>
      [...queryKeys.payments.all, 'wallet', userId || 'current'] as const,
    walletTransactions: (limit?: number, offset?: number, userId?: string) =>
      [
        ...queryKeys.payments.all,
        'wallet',
        userId || 'current',
        'transactions',
        limit,
        offset,
      ] as const,
  },
} as const;

/**
 * Helper to invalidate all account-related queries
 */
export const invalidateAccountQueries = (queryClient: QueryClient): void => {
  queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all });
};

/**
 * Helper to invalidate all user-related queries
 */
export const invalidateUserQueries = (queryClient: QueryClient): void => {
  queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
};

/**
 * Helper to invalidate all session-related queries
 */
export const invalidateSessionQueries = (queryClient: QueryClient): void => {
  queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
};

/**
 * Helper to invalidate all privacy-settings queries
 */
export const invalidatePrivacyQueries = (queryClient: QueryClient): void => {
  queryClient.invalidateQueries({ queryKey: queryKeys.privacy.all });
};

/**
 * Helper to invalidate all payments / wallet / subscription queries
 */
export const invalidatePaymentsQueries = (queryClient: QueryClient): void => {
  queryClient.invalidateQueries({ queryKey: queryKeys.payments.all });
};

/**
 * Helper to invalidate the user's connected-apps list
 */
export const invalidateConnectedAppsQueries = (queryClient: QueryClient): void => {
  queryClient.invalidateQueries({ queryKey: queryKeys.connectedApps.all });
};

/**
 * Helper to invalidate the user's file library (all owners). Pass an ownerId via
 * `queryKeys.files.list(ownerId)` for a scoped invalidation instead.
 */
export const invalidateFileQueries = (queryClient: QueryClient): void => {
  queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
};
