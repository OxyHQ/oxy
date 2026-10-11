import { normalizedAppEventSchema, type NormalizedAppEvent } from '@oxy.so/contracts';
import type { DatabaseOrTransaction } from '../config/postgres';
import { normalizedAppEventOutbox } from '../db/schema/normalizedAppEventOutbox';

function likelyNeedsResponse(input: {
  senderAddress: string;
  subject: string;
  headers: Record<string, string>;
}): string | null {
  const sender = input.senderAddress.toLowerCase();
  if (/\b(?:no-?reply|do-?not-?reply|notifications?)\b/.test(sender)) return null;
  const autoSubmitted = input.headers['auto-submitted']?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return null;
  if (/^(?:bulk|list|junk)$/i.test(input.headers.precedence ?? '')) return null;
  if (/\b(?:receipt|newsletter|notification|statement)\b/i.test(input.subject)) return null;
  return 'Direct non-automated incoming message';
}

export interface InboxMessageEventInput {
  ownerAccountId: string;
  mailboxId: string;
  messageId: string;
  senderAddress: string;
  subject: string;
  headers: Record<string, string>;
  receivedAt: Date;
  /**
   * The one-line preview Inbox already shows in its list (`buildSnippet`,
   * bounded to 140 characters). Carried so a subscriber can judge importance
   * without reading the message; never the body, never headers.
   */
  snippet: string;
  /** `inbox`, or `spam` when spam scoring filed it in Junk. */
  folder: 'inbox' | 'spam';
}

/** Longest snippet an event carries, whatever the caller passed. */
export const INBOX_EVENT_SNIPPET_MAX = 140;

export function buildInboxMessageEvents(input: InboxMessageEventInput): NormalizedAppEvent[] {
  const resource = {
    appId: 'inbox',
    effectiveAccountId: input.ownerAccountId,
    resourceType: 'mailbox',
    resourceId: input.mailboxId,
  } as const;
  const events: NormalizedAppEvent[] = [
    {
      eventId: `${input.messageId}:new_email`,
      appId: 'inbox',
      accountId: input.ownerAccountId,
      resource,
      type: 'new_email',
      occurredAt: input.receivedAt.toISOString(),
      data: {
        messageId: input.messageId,
        mailboxId: input.mailboxId,
        from: input.senderAddress,
        subject: input.subject,
        snippet: input.snippet.slice(0, INBOX_EVENT_SNIPPET_MAX),
        folder: input.folder,
      },
    },
  ];
  const reason = input.folder === 'spam' ? null : likelyNeedsResponse(input);
  if (reason) {
    events.push({
      eventId: `${input.messageId}:email_needs_reply`,
      appId: 'inbox',
      accountId: input.ownerAccountId,
      resource,
      type: 'email_needs_reply',
      occurredAt: input.receivedAt.toISOString(),
      data: { messageId: input.messageId, mailboxId: input.mailboxId, reason },
    });
  }
  return events.map((event) => normalizedAppEventSchema.parse(event));
}

/** Insert both Inbox events on the transaction that stores the message. */
export async function enqueueInboxMessageEvents(
  db: DatabaseOrTransaction,
  input: InboxMessageEventInput,
): Promise<void> {
  const events = buildInboxMessageEvents(input);
  await db
    .insert(normalizedAppEventOutbox)
    .values(events.map((event) => ({ eventId: event.eventId, appId: event.appId, event })))
    .onConflictDoNothing({ target: normalizedAppEventOutbox.eventId });
}
