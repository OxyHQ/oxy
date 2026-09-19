/**
 * Shared Socket.IO event payload types.
 *
 * Events are emitted to authenticated `user:${userId}` rooms set up by the
 * main Socket.IO connection handler in `server.ts`. Keep this file the single
 * source of truth so server emitters and client consumers stay in sync.
 *
 * The Inbox client mirrors these in
 * `Inbox/packages/frontend/hooks/useInboxSocket.ts` — both sides MUST change
 * together.
 */

/**
 * Emitted to `user:${userId}` when a new inbound email is delivered to one
 * of the user's mailboxes. Receiving clients should append the message to
 * their local feed and surface a notification badge.
 *
 * Emitted from {@link EmailService.storeIncomingMessage}, the single chokepoint
 * every ingest path goes through — the Cloudflare Email Routing webhook, the
 * SMTP listener, `.eml` import and the welcome message alike.
 */
export interface EmailNewEvent {
  /**
   * The stored row's primary key. STABLE and unique, so it is what a client
   * dedupes an optimistic insert against. Distinct from {@link messageId}:
   * conflating the two was a real bug — a client matching a row id against the
   * `Message-Id` column can never find a match, so every new mail rendered
   * twice until the reconciling refetch landed.
   */
  id: string;
  /** The RFC 5322 `Message-Id` header, as the sender wrote it. */
  messageId: string;
  mailboxId: string;
  folder: string;
  from: { name?: string; address: string };
  subject: string;
  snippet: string;
  receivedAt: string;
  unread: true;
}

/**
 * Emitted to `user:${userId}` alongside `email:new` so unread badges can
 * update without a follow-up HTTP fetch.
 */
export interface EmailUnreadCountEvent {
  mailboxId: string;
  unread: number;
}

/** Why a message a client already holds is no longer what it holds. */
export type EmailChangedReason = 'flags' | 'labels' | 'moved' | 'deleted' | 'sent';

/**
 * Emitted to `user:${userId}` when an EXISTING message changes — read/unread,
 * starred, labelled, moved, deleted, or a new message landing in Sent.
 *
 * Deliberately carries no message body: it is a signal, not a payload. A client
 * answers it by invalidating the affected mailbox lists, which re-reads through
 * the same authorised HTTP path it always uses. That keeps a second device in
 * sync without inventing a second, privileged read channel.
 *
 * `mailboxIds` carries EVERY affected mailbox — for a move that is both the
 * source and the destination, so a client viewing either one refreshes.
 */
export interface EmailChangedEvent {
  id: string;
  mailboxIds: string[];
  reason: EmailChangedReason;
}
