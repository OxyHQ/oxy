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
 * compared with: its outbox claim (an immediate send; rows written before this
 * existed included), or its filed Sent row (a scheduled send, which has no
 * claim until it falls due).
 *
 * So it reads only what both records keep, normalised as the Sent row stores
 * it (addresses trimmed and lower-cased, names trimmed). Only what the CLIENT
 * chose counts: the sender identity is the server's, and an attachment's name,
 * type and size are mirrored from its file, so renaming a file between a send
 * and its retry is not a new message. A read-receipt request is not recorded
 * on a Sent row, so it is not part of the rule.
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
    payload.references ?? [],
    (payload.attachments ?? []).map((a) => [a.fileId, a.contentId ?? null, a.isInline === true]),
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Refuse a repeat of an Idempotency-Key that asks for a different message than
 * the send the key already made (`stored`). It is not a retry: answering it as
 * one reports it accepted while only the first message exists, and lets the
 * caller delete the draft it was written in.
 */
export function refuseReusedSendKey(
  stored: EmailOutboxPayload,
  requested: EmailOutboxPayload,
): void {
  if (sendRequestFingerprint(stored) === sendRequestFingerprint(requested)) return;
  throw new ValidationError(
    'This Idempotency-Key was already used for a different message. Send this one with a new key.',
    { reason: 'idempotency_key_reused' },
  );
}
