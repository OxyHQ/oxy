import { createHash } from 'node:crypto';
import { EMAIL_DOMAIN } from '../config/email.config';
import type { EmailOutboxPayload } from '../db/schema/emailOutbox';
import type { EmailAddress } from '../db/schema/messages';
import { ValidationError } from '../utils/error';

/**
 * Derive the RFC Message-ID used for a client retry key. The user id is part
 * of the input so the same key can safely be reused by different accounts.
 */
export function idempotentMessageId(userId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${userId}\0${idempotencyKey}`)
    .digest('hex')
    .slice(0, 40);
  return `<${digest}@${EMAIL_DOMAIN}>`;
}

/**
 * What a send under an Idempotency-Key asked for, as a digest — the ONE rule
 * for "the same message", whichever record of the first send a repeat is
 * compared with: its outbox claim, or (for a send filed before claims) its
 * Sent row.
 *
 * Only what the CLIENT chose counts, as both records keep it and normalised as
 * the Sent row stores it (addresses trimmed and lower-cased, names trimmed):
 * - threading is the parent the client named (`inReplyTo`), never the
 *   `References` the server derives from that parent, which change when the
 *   parent does — a retry after it changed or was deleted is still a retry;
 * - the sender identity is the server's;
 * - an attachment's name, type and size are mirrored from its file, so
 *   renaming a file between a send and its retry is not a new message;
 * - a read-receipt request is not recorded on a Sent row.
 */
export function sendRequestFingerprint(payload: EmailOutboxPayload): string {
  const recipients = (list: EmailAddress[] | undefined) =>
    (list ?? []).map((r) => [r.name?.trim() ?? '', r.address.trim().toLowerCase()]);
  const canonical = [
    recipients(payload.to),
    recipients(payload.cc),
    recipients(payload.bcc),
    payload.subject,
    payload.text ?? null,
    payload.html ?? null,
    payload.inReplyTo ?? null,
    (payload.attachments ?? []).map((a) => [a.fileId, a.contentId ?? null, a.isInline === true]),
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Where the send a key already made stands, as a refusal reports it, so a
 * client says what is true — "already sent", "scheduled for…", "failed",
 * "cancelled" — instead of assuming it left. `unknown` is a send from before
 * deliveries were recorded.
 */
export type SentUnderKeyState =
  | 'scheduled'
  | 'sending'
  | 'retrying'
  | 'sent'
  | 'failed'
  | 'cancelled'
  | 'unknown';

/** The send a key already made, as a refusal names it. */
export interface SentUnderKey {
  /** Its Sent row, when one is filed. */
  id: string | null;
  /** Its RFC 5322 Message-ID. */
  messageId: string;
  deliveryState: SentUnderKeyState;
  /** When it is due, while it is `scheduled`. */
  scheduledAt: Date | null;
}

/**
 * Refuse a repeat of an Idempotency-Key that cannot be answered with the send
 * the key already made (`sent`, which asked for `stored`):
 * - it asks for a different message — not a retry: answering it as one reports
 *   it accepted while only the first message exists, and lets the caller
 *   delete the draft it was written in;
 * - or that send was cancelled (a scheduled message deleted or taken out of
 *   Sent before it was due, a delivery the user cancelled) — answering would
 *   report as accepted a send that never happens.
 *
 * The refusal names that send and says where it stands (`details`), so a
 * client that restored the key after a crash can tell the user the truth.
 */
export function refuseReusedSendKey(
  stored: EmailOutboxPayload,
  requested: EmailOutboxPayload,
  sent: SentUnderKey,
): void {
  const same = sendRequestFingerprint(stored) === sendRequestFingerprint(requested);
  if (same && sent.deliveryState !== 'cancelled') return;
  throw new ValidationError(
    same
      ? 'The message sent under this Idempotency-Key was cancelled. Send it again with a new key.'
      : 'This Idempotency-Key was already used for a different message. Send this one with a new key.',
    {
      reason: 'idempotency_key_reused',
      id: sent.id,
      messageId: sent.messageId,
      deliveryState: sent.deliveryState,
      scheduledAt: sent.scheduledAt?.toISOString() ?? null,
    },
  );
}
