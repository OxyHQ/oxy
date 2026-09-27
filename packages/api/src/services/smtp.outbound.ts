import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import {
  SMTP_OUTBOUND_CONFIG,
  SMTP_RELAYS,
  DKIM_CONFIG,
  EMAIL_DOMAIN,
  type SmtpRelayConfig,
} from '../config/email.config';
import { emailService } from './email.service';
import { assetService } from './assetServiceSingleton';
import type { MessageAttachment } from '../db/schema/messageAttachments';
import type { EmailAddress } from '../db/schema/messages';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { idempotentMessageId } from './emailIdempotency';
import {
  claimIdempotentSend,
  enqueueEmailOutbox,
  markEmailOutboxFailed,
  markEmailOutboxSent,
  releaseIdempotentSend,
} from './emailOutbox.service';
import { OXY_SENT_ID_HEADER, relayAssignedMessageId } from './relayMessageId';
import type { EmailOutboxPayload } from '../db/schema/emailOutbox';
import { assertSafeOutboundAttachment } from '../utils/emailAttachmentSecurity';
import { ServiceUnavailableError } from '../utils/error';

interface OutboundMessage {
  userId: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: MessageAttachment[];
  /** When true, add Disposition-Notification-To header requesting a read receipt */
  requestReadReceipt?: boolean;
  /** Stable client key used to make retries return the original outcome. */
  idempotencyKey?: string;
  messageId?: string;
}

const SECURE_MAIL_CONTENT_OPTIONS = {
  disableFileAccess: true,
  disableUrlAccess: true,
} satisfies Pick<SMTPTransport.Options, 'disableFileAccess' | 'disableUrlAccess'>;

/** What the durable outbox keeps to deliver a message later. */
function outboxPayload(message: OutboundMessage): EmailOutboxPayload {
  return {
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyTo,
    references: message.references,
    attachments: message.attachments,
    requestReadReceipt: message.requestReadReceipt,
  };
}

/**
 * Thrown when outbound email cannot be attempted at all because the relay is
 * not configured. NOT an SMTP failure: nothing was ever said to a server.
 *
 * It is a subclass of {@link ServiceUnavailableError} so the route answers 503
 * with an actionable message instead of 202 `queued`.
 */
export class SmtpConfigurationError extends ServiceUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpConfigurationError';
  }
}

/**
 * SMTP auth rejections. nodemailer reports a bad credential as `EAUTH`, and the
 * server's own 5xx (`535 Authentication credentials invalid`) may or may not
 * survive onto the error object depending on where the handshake died.
 */
function isAuthenticationFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; responseCode?: unknown; command?: unknown };
  if (e.code === 'EAUTH') return true;
  return e.responseCode === 535 && e.command === 'AUTH PLAIN';
}

/**
 * Is this failure worth retrying later, or is it permanent?
 *
 * The old answer was "anything without a numeric `responseCode` is transient",
 * and that is how a MISCONFIGURATION became invisible: `createTransporter()`
 * throwing "SMTP_RELAY_HOST is required" has no `responseCode`, so it was
 * classified as a transient SMTP hiccup, the message was queued, the API
 * answered 202 `Message queued for delivery`, and the worker then failed the
 * same way on every retry until it gave up. Nothing was sent and nothing looked
 * broken.
 *
 * Three things are permanent, and none of them get queued:
 *  - a configuration error (no relay) — retrying cannot fix it, an operator must;
 *  - an authentication failure — the credential is wrong, not busy;
 *  - a 5xx SMTP reply — the server has refused this message, by definition
 *    permanently (RFC 5321 §4.2.1).
 *
 * Everything else — a timeout, a connection reset, a 4xx greylisting — is
 * genuinely transient and belongs in the durable outbox.
 */
export function isRetryableSmtpFailure(error: unknown): boolean {
  if (error instanceof SmtpConfigurationError) return false;
  if (isAuthenticationFailure(error)) return false;
  if (typeof error !== 'object' || error === null || !('responseCode' in error)) return true;
  const responseCode = error.responseCode;
  return typeof responseCode !== 'number' || responseCode < 500 || responseCode >= 600;
}

/**
 * Whether an outbound relay is configured at all. Read at boot by
 * {@link assertOutboundRelayConfigured} so a deployment that cannot send says
 * so on startup rather than on a user's first message.
 */
export function isOutboundRelayConfigured(): boolean {
  return SMTP_RELAYS.length > 0;
}

/**
 * Is this failure the RELAY's fault rather than the message's?
 *
 * Only these advance to the next configured relay. A 5xx on the message itself
 * is a verdict about the message, and re-offering it elsewhere would spend a
 * second provider's reputation on mail that is going to be refused again.
 */
function isRelayTransportFailure(error: unknown): boolean {
  if (error instanceof SmtpConfigurationError) return false;
  if (isAuthenticationFailure(error)) return true;
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; responseCode?: unknown };
  if (typeof e.code === 'string'
    && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ENOTFOUND', 'EHOSTUNREACH'].includes(e.code)) {
    return true;
  }
  // 421 "service not available" and 451 are the shapes a provider uses when it
  // has stopped carrying your traffic.
  return e.responseCode === 421 || e.responseCode === 451;
}

class SmtpOutboundService {
  private transporters = new Map<string, Transporter>();

  /** The configured relays, in preference order. */
  private get relays(): SmtpRelayConfig[] {
    if (SMTP_RELAYS.length === 0) {
      throw new SmtpConfigurationError(
        'Outbound email is not configured on this server: SMTP_RELAY_HOST is unset. ' +
          'Nodemailer removed the legacy `{ direct: true }` MX-resolution path, so a relay ' +
          'is mandatory; set SMTP_RELAY_HOST/SMTP_RELAY_PORT/SMTP_RELAY_USER/SMTP_RELAY_PASS. ' +
          'The host accepts a comma-separated list for failover.'
      );
    }
    return SMTP_RELAYS;
  }

  private transporterFor(relay: SmtpRelayConfig): Transporter {
    const existing = this.transporters.get(relay.name);
    if (existing) return existing;
    const created = this.createTransporter(relay);
    this.transporters.set(relay.name, created);
    return created;
  }

  private createTransporter(relay: SmtpRelayConfig): Transporter {
    const transportConfig: SMTPTransport.Options = {
      host: relay.host,
      port: relay.port,
      secure: relay.port === 465,
      auth: relay.user && relay.pass ? { user: relay.user, pass: relay.pass } : undefined,
      ...SECURE_MAIL_CONTENT_OPTIONS,
    };

    if (DKIM_CONFIG.privateKey) {
      transportConfig.dkim = {
        domainName: DKIM_CONFIG.domainName,
        keySelector: DKIM_CONFIG.keySelector,
        privateKey: DKIM_CONFIG.privateKey,
      };
    }

    return nodemailer.createTransport(transportConfig);
  }

  /**
   * Hand `mailOptions` to the first relay that will take it.
   *
   * Advances only on a transport failure; a message-level refusal is rethrown
   * immediately so it is never re-offered elsewhere. If every relay fails on
   * transport, the LAST error propagates — it is the one describing the state
   * the system ended in.
   */
  private async deliverThroughRelays(
    mailOptions: Parameters<Transporter['sendMail']>[0],
  ): Promise<{ relayMessageId: string | null }> {
    const relays = this.relays;
    let lastError: unknown;
    for (let i = 0; i < relays.length; i++) {
      const relay = relays[i];
      try {
        const info: { response?: string } = await this.transporterFor(relay).sendMail(mailOptions);
        if (i > 0) {
          logger.warn('Outbound email delivered through a fallback relay', {
            relay: relay.name,
            skipped: relays.slice(0, i).map((r) => r.name).join(', '),
          });
        }
        return { relayMessageId: relayAssignedMessageId(relay.host, info.response) };
      } catch (error) {
        lastError = error;
        if (!isRelayTransportFailure(error) || i === relays.length - 1) throw error;
        logger.warn('Outbound relay unavailable, trying the next one', {
          relay: relay.name,
          next: relays[i + 1].name,
          error: error instanceof Error ? error.message : String(error),
        });
        // A transporter that just failed on transport may be holding a dead
        // pooled connection; drop it so the next attempt reconnects.
        this.transporters.delete(relay.name);
      }
    }
    throw lastError;
  }

  /**
   * The nodemailer options for one user message. `X-Oxy-Sent-Id` carries OUR
   * Message-ID through relays that replace the header (SES does), so when the
   * message comes back to one of our own users — a sender on their own
   * recipient list — it can be recognised as the copy of a Sent row.
   */
  private mailOptionsFor(
    message: OutboundMessage,
    messageId: string,
    attachments: Awaited<ReturnType<SmtpOutboundService['resolveAttachments']>>,
  ): Parameters<Transporter['sendMail']>[0] {
    const format = (a: EmailAddress) => (a.name ? `${a.name} <${a.address}>` : a.address);
    const sender = `${message.from.name || ''} <${message.from.address}>`.trim();
    return {
      messageId,
      from: sender,
      to: message.to.map(format).join(', '),
      cc: message.cc?.map(format).join(', '),
      bcc: message.bcc?.map(format).join(', '),
      subject: message.subject,
      text: message.text,
      html: message.html,
      inReplyTo: message.inReplyTo,
      references: message.references?.join(' '),
      attachments,
      headers: {
        [OXY_SENT_ID_HEADER]: messageId,
        ...(message.requestReadReceipt ? { 'Disposition-Notification-To': sender } : {}),
      },
      ...SECURE_MAIL_CONTENT_OPTIONS,
    };
  }

  /**
   * Send a user's message and file it in their Sent mailbox.
   *
   * With an `idempotencyKey`, the send is first CLAIMED durably
   * ({@link claimIdempotentSend}): a retry of the same key — from a client that
   * timed out while the relay was still talking, from a double press, or on
   * another API task — returns the first attempt's outcome instead of sending
   * again. `queued: true` then means "accepted and still in flight or waiting
   * to retry"; the outbox shows which.
   */
  async send(message: OutboundMessage): Promise<{ messageId: string; queued: boolean }> {
    if (!message.idempotencyKey) {
      return this.deliverAndStore(message, `<${uuidv4()}@${EMAIL_DOMAIN}>`, null);
    }

    const messageId = idempotentMessageId(message.userId, message.idempotencyKey);
    // Delivered and filed before the outbox row existed, or before it was kept.
    if (await emailService.findMessageByRfcMessageId(message.userId, messageId)) {
      return { messageId, queued: false };
    }

    const claim = await claimIdempotentSend({
      userId: message.userId,
      idempotencyKey: message.idempotencyKey,
      messageId,
      payload: outboxPayload(message),
      owner: `request:${uuidv4()}`,
    });
    if (!claim.claimed) {
      return { messageId: claim.existing.messageId, queued: claim.existing.status !== 'sent' };
    }
    return this.deliverAndStore(message, messageId, claim.outboxId);
  }

  private async deliverAndStore(
    message: OutboundMessage,
    messageId: string,
    outboxId: string | null,
  ): Promise<{ messageId: string; queued: boolean }> {
    try {
      const attachments = await this.resolveAttachments(message.attachments || []);
      const { relayMessageId } = await this.deliverThroughRelays(this.mailOptionsFor(message, messageId, attachments));

      const size = Buffer.byteLength((message.text || '') + (message.html || ''), 'utf8');
      await emailService.storeSentMessage(message.userId, {
        messageId,
        relayMessageId,
        from: message.from,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject,
        text: message.text,
        html: message.html,
        inReplyTo: message.inReplyTo,
        references: message.references,
        attachments: message.attachments,
        size,
      });
      if (outboxId) await markEmailOutboxSent(outboxId);

      logger.info('Email sent', {
        messageId,
        to: message.to.map((a) => a.address).join(', '),
      });
      return { messageId, queued: false };
    } catch (error) {
      if (!isRetryableSmtpFailure(error)) {
        // Permanent. Do NOT queue: a row in the outbox is a promise that this
        // message will go out later, and that promise would be a lie. Give the
        // claim back and let it propagate so the caller answers with a real
        // failure — and a corrected retry with the same key can try again.
        if (outboxId) await releaseIdempotentSend(outboxId);
        logger.error(
          'Email send permanently rejected; not queued',
          error instanceof Error ? error : new Error(String(error)),
          { messageId, to: message.to.map((a) => a.address).join(', ') },
        );
        throw error;
      }
      logger.error('Email send failed, queuing for retry', error instanceof Error ? error : new Error(String(error)));
      const nextAttemptAt = new Date(Date.now() + SMTP_OUTBOUND_CONFIG.retryDelays[0]);
      if (outboxId) {
        await markEmailOutboxFailed(outboxId, error, nextAttemptAt);
      } else {
        await enqueueEmailOutbox({
          userId: message.userId,
          messageId,
          payload: outboxPayload(message),
          nextAttemptAt,
        });
      }
      logger.warn('Email persisted in durable outbox', { messageId });
      return { messageId, queued: true };
    }
  }

  /**
   * Send a message via SMTP without storing it in the Sent mailbox — for mail
   * that is already stored (scheduled, outbox) or never is (forwarding).
   * Returns the id the relay substituted for ours, if it did.
   */
  async sendRaw(message: OutboundMessage): Promise<{ relayMessageId: string | null }> {
    const messageId = message.messageId ?? `<${uuidv4()}@${EMAIL_DOMAIN}>`;
    const attachments = await this.resolveAttachments(message.attachments || []);
    const delivered = await this.deliverThroughRelays(this.mailOptionsFor(message, messageId, attachments));

    logger.info('Raw email sent', {
      messageId,
      to: message.to.map((a) => a.address).join(', '),
    });
    return delivered;
  }

  /**
   * Send mail from Oxy itself (`Oxy <noreply@…>`) — a verification code, an
   * account notice — to one address. Not stored in any mailbox and never
   * queued: what it carries is short-lived, so a send that fails now is
   * reported now rather than delivered stale.
   */
  async sendSystem(message: { to: string; subject: string; text: string; html: string }): Promise<void> {
    await this.deliverThroughRelays({
      messageId: `<${uuidv4()}@${EMAIL_DOMAIN}>`,
      from: `Oxy <noreply@${EMAIL_DOMAIN}>`,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: { 'Auto-Submitted': 'auto-generated' },
      ...SECURE_MAIL_CONTENT_OPTIONS,
    });
  }

  /**
   * Send an MDN (Message Disposition Notification) per RFC 3798.
   * This is a multipart/report message with a human-readable part and a machine-readable
   * disposition-notification part.
   */
  async sendMdn(params: {
    from: EmailAddress;
    to: string;
    originalRecipient: string;
    originalMessageId: string;
    originalSubject: string;
  }): Promise<void> {
    const mdnMessageId = `<${uuidv4()}@${EMAIL_DOMAIN}>`;
    const boundary = `----=_MDN_${uuidv4().replace(/-/g, '')}`;
    const reportingUA = 'inbox.oxy.so; Inbox by Oxy';
    const now = new Date().toUTCString();

    // Human-readable part
    const humanText = [
      `Your message was displayed to ${params.originalRecipient}.`,
      '',
      `  Subject: ${params.originalSubject}`,
      `  Date: ${now}`,
      '',
      'This is a Message Disposition Notification (MDN) confirming that',
      'the message was displayed by the recipient\'s mail client.',
    ].join('\r\n');

    // Machine-readable part (RFC 3798 Section 3.2.6)
    const disposition = [
      `Reporting-UA: ${reportingUA}`,
      `Original-Recipient: rfc822;${params.originalRecipient}`,
      `Final-Recipient: rfc822;${params.originalRecipient}`,
      `Original-Message-ID: ${params.originalMessageId}`,
      'Disposition: manual-action/MDN-sent-manually; displayed',
    ].join('\r\n');

    // Build the raw MIME message
    const rawMessage = [
      `From: ${params.from.name || ''} <${params.from.address}>`.trim(),
      `To: ${params.to}`,
      `Subject: Read: ${params.originalSubject}`,
      `Date: ${now}`,
      `Message-ID: ${mdnMessageId}`,
      `In-Reply-To: ${params.originalMessageId}`,
      `References: ${params.originalMessageId}`,
      'MIME-Version: 1.0',
      'Auto-Submitted: auto-replied',
      `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      humanText,
      '',
      `--${boundary}`,
      'Content-Type: message/disposition-notification',
      'Content-Transfer-Encoding: 7bit',
      '',
      disposition,
      '',
      `--${boundary}--`,
    ].join('\r\n');

    // An MDN is ordinary outbound mail and gets the same failover.
    await this.deliverThroughRelays({
      envelope: {
        from: params.from.address,
        to: params.to,
      },
      raw: rawMessage,
      ...SECURE_MAIL_CONTENT_OPTIONS,
    });

    logger.info('MDN sent', {
      messageId: mdnMessageId,
      to: params.to,
      originalMessageId: params.originalMessageId,
    });
  }

  private async resolveAttachments(
    attachments: MessageAttachment[]
  ): Promise<Array<{ filename: string; content: Buffer; contentType: string; cid?: string }>> {
    type ResolvedAttachment = { filename: string; content: Buffer; contentType: string; cid?: string };

    const results = await Promise.all(
      attachments.map(async (att): Promise<ResolvedAttachment | null> => {
        try {
          assertSafeOutboundAttachment(att.name, att.contentType);
          const buffer = await assetService.getFileBuffer(att.fileId);
          if (!buffer) return null;
          return {
            filename: att.name,
            content: buffer,
            contentType: att.contentType,
            ...(att.contentId ? { cid: att.contentId } : {}),
          };
        } catch (err) {
          logger.error(
            'Failed to fetch attachment from Oxy file manager',
            err instanceof Error ? err : new Error(String(err)),
            { fileId: att.fileId }
          );
          return null;
        }
      })
    );

    return results.filter((r): r is ResolvedAttachment => r !== null);
  }

  shutdown(): void {
    for (const transporter of this.transporters.values()) {
      transporter.close();
    }
    this.transporters.clear();
  }
}

export const smtpOutbound = new SmtpOutboundService();
export default smtpOutbound;
