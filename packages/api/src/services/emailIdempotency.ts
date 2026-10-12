import { createHash } from 'node:crypto';
import { EMAIL_DOMAIN } from '../config/email.config';
import type { EmailOutboxPayload } from '../db/schema/emailOutbox';
import type { EmailAddress } from '../db/schema/messages';

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
 * What a send under an Idempotency-Key asked for, as a digest. A repeat of the
 * key must carry the same message; one that does not is a different send
 * reusing a key, and answering it with the first one's acceptance drops it
 * without a word — and lets the caller delete the draft it was written in.
 *
 * Computed from the outbox payload, which the claim row keeps, so a repeat is
 * compared with what the first send stored, rows written before this existed
 * included. Only what the CLIENT chose counts: the sender identity is the
 * server's, and an attachment's name, type and size are mirrored from its
 * file, so renaming a file between a send and its retry is not a new message.
 */
export function sendRequestFingerprint(payload: EmailOutboxPayload): string {
  const recipients = (list: EmailAddress[] | undefined) =>
    (list ?? []).map((r) => [r.name ?? '', r.address]);
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
    payload.requestReadReceipt === true,
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
