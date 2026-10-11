/**
 * The ONE place a received RFC 5322 message becomes the fields the mail store
 * takes. The Cloudflare webhook (`routes/emailInbound.ts`), the SMTP listener
 * (`services/smtp.inbound.ts`) and `.eml` import (`EmailService.importMessages`)
 * all call it, so the three can no longer disagree about what a message is.
 *
 * They used to: each mapped mailparser's output by hand, and import derived
 * `isInline` from `related` while the other two used the disposition.
 *
 * ## Alternative bodies are not attachments
 *
 * mailparser treats a leaf part as a body only when it is `text/plain` or
 * `text/html`; every other leaf without a disposition becomes an ATTACHMENT.
 * So the AMP representation of a `multipart/alternative` (`text/x-amp-html`,
 * which Ramp, Google, Booking and most transactional senders include) was
 * uploaded as a file named "attachment" and shown under every such mail. It is
 * the same content as the HTML body in another format, and a client that
 * cannot render AMP must ignore it (RFC 2046 §5.1.4). Parts in
 * {@link ALTERNATIVE_BODY_TYPES} are dropped unless the sender explicitly made
 * them a file — a filename or `Content-Disposition: attachment`.
 *
 * mailparser does not report which multipart a part sat in, so the test is the
 * content type. These types exist only as alternative renderings of a body;
 * nobody attaches a `text/x-amp-html` file.
 */

import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from 'mailparser';

/**
 * Media types that are only ever an alternative rendering of the message body.
 * `text/x-amp-html` is AMP for Email; `text/watch-html` is Apple Watch's.
 */
export const ALTERNATIVE_BODY_TYPES: ReadonlySet<string> = new Set([
  'text/x-amp-html',
  'text/watch-html',
]);

export interface InboundAddress {
  name: string;
  address: string;
}

export interface InboundAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  size: number;
  /** The `Content-ID` header, brackets included, when the part had one. */
  contentId?: string;
  /**
   * Rendered in the body rather than listed: `Content-Disposition: inline`, or
   * a part of a `multipart/related` that the HTML references by Content-ID.
   */
  isInline: boolean;
}

export interface InboundMime {
  from: InboundAddress | null;
  /**
   * The `Reply-To` header: where replies go. Support desks, mailing lists and
   * no-reply senders rely on it; without it a reply goes to `From` and bounces.
   */
  replyTo: InboundAddress | null;
  to: InboundAddress[];
  cc: InboundAddress[];
  subject: string;
  text: string | undefined;
  html: string | undefined;
  /** The `Message-ID` header, or `null` when the sender omitted it. */
  messageId: string | null;
  inReplyTo: string | undefined;
  references: string[];
  date: Date | undefined;
  headers: Record<string, string>;
  attachments: InboundAttachment[];
}

/** Whether a parsed part is an alternative rendering of the body, not a file. */
export function isAlternativeBody(
  att: Pick<Attachment, 'contentType' | 'filename' | 'contentDisposition'>,
): boolean {
  if (att.filename) return false;
  if (att.contentDisposition === 'attachment') return false;
  return ALTERNATIVE_BODY_TYPES.has((att.contentType || '').toLowerCase());
}

function addresses(field: AddressObject | AddressObject[] | undefined): InboundAddress[] {
  if (!field) return [];
  return (Array.isArray(field) ? field : [field])
    .flatMap((group) => group.value)
    .map((a) => ({ name: a.name || '', address: a.address || '' }));
}

function toAttachment(att: Attachment): InboundAttachment {
  return {
    filename: att.filename || 'attachment',
    contentType: att.contentType || 'application/octet-stream',
    content: att.content,
    size: att.size || att.content.length,
    ...(att.contentId ? { contentId: att.contentId } : {}),
    isInline: att.contentDisposition === 'inline' || att.related === true,
  };
}

/** Normalise an already-parsed message. Exported for callers that parse once for other reasons. */
export function fromParsedMail(parsed: ParsedMail): InboundMime {
  const headers: Record<string, string> = {};
  parsed.headers?.forEach((value, key) => {
    headers[key] = typeof value === 'string' ? value : JSON.stringify(value);
  });

  const references = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? [parsed.references]
      : [];

  return {
    from: addresses(parsed.from)[0] ?? null,
    replyTo: addresses(parsed.replyTo).find((a) => a.address) ?? null,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: parsed.subject || '',
    text: parsed.text,
    html: typeof parsed.html === 'string' ? parsed.html : undefined,
    messageId: parsed.messageId || null,
    inReplyTo:
      typeof parsed.inReplyTo === 'string' && parsed.inReplyTo ? parsed.inReplyTo : undefined,
    references,
    date: parsed.date,
    headers,
    attachments: (parsed.attachments || [])
      .filter((att) => !isAlternativeBody(att))
      .map(toAttachment),
  };
}

/** Parse a raw RFC 5322 message into the fields the mail store takes. */
export async function parseInboundMime(raw: Buffer | string): Promise<InboundMime> {
  return fromParsedMail(await simpleParser(raw));
}
