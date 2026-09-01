/**
 * Centralized TanStack Query key factory for the Inbox app.
 *
 * SINGLE SOURCE OF TRUTH for every query/mutation key used across hooks,
 * `messageCache`, the realtime socket, and the offline persistence whitelist.
 * No magic key strings should appear anywhere else in the app.
 *
 * Key shapes are preserved EXACTLY as they were when inlined, so cache
 * identity, the socket's positional predicate (`key[0]`, `key[1]`, `key[4]`),
 * and persisted blobs remain compatible:
 *   - messages list : ['messages', mailboxId|null, starred, label|null, userId]
 *   - message detail : ['message', messageId, userId]
 *   - thread         : ['thread', messageId]
 *   - mailboxes      : ['mailboxes', userId]
 *
 * Convention:
 *   - `root` / bare arrays  → broad keys for invalidate / setQueriesData.
 *   - builder functions     → fully-qualified keys for a single query.
 */

export interface MessagesListParams {
  mailboxId?: string;
  starred?: boolean;
  label?: string;
  userId: string | null;
}

export interface SearchOptions {
  q?: string;
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  dateAfter?: string;
  dateBefore?: string;
  mailbox?: string;
  starred?: boolean;
  label?: string;
}

/** Query keys for the email/inbox domain. */
export const emailKeys = {
  messages: {
    /** Broad key matching every messages-list variant. */
    root: ['messages'] as const,
    /** Fully-qualified infinite-list key for a given view. */
    list: ({ mailboxId, starred, label, userId }: MessagesListParams) =>
      ['messages', mailboxId ?? null, starred ?? false, label ?? null, userId] as const,
    /** Prefix key matching every variant within a single mailbox. */
    mailboxScope: (mailboxId: string | null | undefined) =>
      ['messages', mailboxId ?? null] as const,
  },
  message: {
    /** Broad key matching every single-message detail entry. */
    root: ['message'] as const,
    /** Fully-qualified detail key (account-scoped). */
    detail: (messageId: string | undefined, userId: string | null) =>
      ['message', messageId, userId] as const,
    /** Prefix key matching a message across accounts (id only). */
    byId: (messageId: string) => ['message', messageId] as const,
  },
  thread: {
    root: ['thread'] as const,
    detail: (messageId: string | undefined) => ['thread', messageId] as const,
  },
  mailboxes: {
    root: ['mailboxes'] as const,
    list: (userId: string | null) => ['mailboxes', userId] as const,
  },
  search: (options: SearchOptions, userId: string | null) =>
    ['search', options, userId] as const,
  quota: (userId: string | null) => ['quota', userId] as const,
  settings: (userId: string | null) => ['settings', userId] as const,
  labels: ['labels'] as const,
  templates: ['templates'] as const,
  filters: ['filters'] as const,
  bundles: ['bundles'] as const,
  subscriptions: ['subscriptions'] as const,
  reminders: {
    root: ['reminders'] as const,
    list: (options?: { includeCompleted?: boolean }) =>
      ['reminders', { includeCompleted: options?.includeCompleted }] as const,
  },
  contacts: {
    root: ['contacts'] as const,
    list: (query: string | null | undefined) => ['contacts', query ?? null] as const,
  },
  contactSuggestions: (query: string) => ['contactSuggestions', query] as const,
  attachmentUrl: (fileId: string, variant?: string) =>
    ['attachment-url', fileId, variant ?? null] as const,
} as const;

/** Query/mutation keys for the Alia AI features. */
export const aiKeys = {
  threadSummary: (messageIdsSignature: string | undefined) =>
    ['threadSummary', messageIdsSignature] as const,
  smartReplies: (messageId: string | undefined) => ['smartReplies', messageId] as const,
  // Its own root, not under 'alia': the brief is one LLM call per day and is
  // worth persisting, while the rest of the `alia` keys are per-interaction
  // scratch space that should not survive a restart.
  dailyBrief: (day: string) => ['daily-brief', day] as const,
  /** Mutation key for the unified AI compose operations. */
  compose: ['alia', 'compose'] as const,
  /** Mutation key for the natural-language search parser. */
  naturalLanguageSearch: ['alia', 'nl-search'] as const,
} as const;

/**
 * Query-key roots that should survive a cold restart (offline persistence).
 * Consumed by `queryClient`'s `shouldDehydrateQuery` whitelist. AI keys are
 * intentionally excluded — they are cheap to regenerate and can go stale.
 */
export const PERSISTED_QUERY_ROOTS: ReadonlySet<string> = new Set([
  'messages',
  'message',
  'thread',
  'mailboxes',
  'labels',
  'settings',
  'quota',
  'bundles',
  'filters',
  'templates',
  'contacts',
  'reminders',
  'subscriptions',
  // Without this the brief is in-memory only, so a cold start re-runs the LLM
  // call the comment above it claims happens once a day.
  'daily-brief',
]);
