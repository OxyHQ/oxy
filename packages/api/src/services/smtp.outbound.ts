import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import {
  SMTP_OUTBOUND_CONFIG,
  DKIM_CONFIG,
  EMAIL_DOMAIN,
} from '../config/email.config';
import { emailService } from './email.service';
import { assetService } from './assetServiceSingleton';
import type { MessageAttachment } from '../db/schema/messageAttachments';
import type { EmailAddress } from '../db/schema/messages';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from '../config/redis';
import { idempotencyCacheKey as buildIdempotencyCacheKey, idempotentMessageId } from './emailIdempotency';
import { enqueueEmailOutbox } from './emailOutbox.service';
import { assertSafeOutboundAttachment } from '../utils/emailAttachmentSecurity';

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

class SmtpOutboundService {
  private _transporter: Transporter | null = null;
  private idempotencyInFlight = new Map<string, Promise<{ messageId: string; queued: boolean }>>();

  private get transporter(): Transporter {
    if (!this._transporter) {
      this._transporter = this.createTransporter();
    }
    return this._transporter;
  }

  private createTransporter(): Transporter {
    if (!SMTP_OUTBOUND_CONFIG.relayHost) {
      throw new Error(
        'SMTP_RELAY_HOST is required for outbound email. Nodemailer removed the legacy ' +
          '`{ direct: true }` MX-resolution path; configure a relay (e.g. AWS SES, SMTP server) ' +
          'via SMTP_RELAY_HOST/SMTP_RELAY_PORT/SMTP_RELAY_USER/SMTP_RELAY_PASS.'
      );
    }

    const transportConfig: SMTPTransport.Options = {
      host: SMTP_OUTBOUND_CONFIG.relayHost,
      port: SMTP_OUTBOUND_CONFIG.relayPort,
      secure: SMTP_OUTBOUND_CONFIG.relayPort === 465,
      auth:
        SMTP_OUTBOUND_CONFIG.relayUser && SMTP_OUTBOUND_CONFIG.relayPass
          ? {
              user: SMTP_OUTBOUND_CONFIG.relayUser,
              pass: SMTP_OUTBOUND_CONFIG.relayPass,
            }
          : undefined,
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

  async send(message: OutboundMessage): Promise<{ messageId: string; queued: boolean }> {
    const messageId = message.idempotencyKey
      ? idempotentMessageId(message.userId, message.idempotencyKey)
      : `<${uuidv4()}@${EMAIL_DOMAIN}>`;
    const idempotencyCacheKey = message.idempotencyKey
      ? buildIdempotencyCacheKey(message.userId, message.idempotencyKey)
      : null;
    const redis = idempotencyCacheKey ? getRedisClient() : null;
    if (redis && redis.status === 'ready' && idempotencyCacheKey) {
      const cached = await redis.get(idempotencyCacheKey);
      if (cached) return JSON.parse(cached) as { messageId: string; queued: boolean };
    }
    if (message.idempotencyKey) {
      const inFlightKey = `${message.userId}:${message.idempotencyKey}`;
      const inFlight = this.idempotencyInFlight.get(inFlightKey);
      if (inFlight) return inFlight;

      const operation = this.sendOnce(message, messageId, redis, idempotencyCacheKey);
      this.idempotencyInFlight.set(inFlightKey, operation);
      try {
        return await operation;
      } finally {
        if (this.idempotencyInFlight.get(inFlightKey) === operation) {
          this.idempotencyInFlight.delete(inFlightKey);
        }
      }
    }
    return this.sendOnce(message, messageId, redis, idempotencyCacheKey);
  }

  private async sendOnce(
    message: OutboundMessage,
    messageId: string,
    redis: ReturnType<typeof getRedisClient>,
    idempotencyCacheKey: string | null,
  ): Promise<{ messageId: string; queued: boolean }> {
    if (message.idempotencyKey) {
      const existing = await emailService.findMessageByRfcMessageId(message.userId, messageId);
      if (existing) return { messageId, queued: false };
    }
    const nmAttachments = await this.resolveAttachments(message.attachments || []);

    const mailOptions = {
      messageId,
      from: `${message.from.name || ''} <${message.from.address}>`.trim(),
      to: message.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
      cc: message.cc?.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
      bcc: message.bcc?.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
      subject: message.subject,
      text: message.text,
      html: message.html,
      inReplyTo: message.inReplyTo,
      references: message.references?.join(' '),
      attachments: nmAttachments,
      headers: message.requestReadReceipt
        ? { 'Disposition-Notification-To': `${message.from.name || ''} <${message.from.address}>`.trim() }
        : undefined,
      ...SECURE_MAIL_CONTENT_OPTIONS,
    };

    try {
      await this.transporter.sendMail(mailOptions);

      const size = Buffer.byteLength((message.text || '') + (message.html || ''), 'utf8');
      await emailService.storeSentMessage(message.userId, {
        messageId,
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

      logger.info('Email sent', {
        messageId,
        to: message.to.map((a) => a.address).join(', '),
      });

      const result = { messageId, queued: false };
      if (redis && idempotencyCacheKey && redis.status === 'ready') {
        await redis.set(idempotencyCacheKey, JSON.stringify(result), 'EX', 24 * 60 * 60);
      }
      return result;
    } catch (error) {
      logger.error('Email send failed, queuing for retry', error instanceof Error ? error : new Error(String(error)));
      await this.enqueue({ ...message, messageId });
      const result = { messageId, queued: true };
      if (redis && idempotencyCacheKey && redis.status === 'ready') {
        await redis.set(idempotencyCacheKey, JSON.stringify(result), 'EX', 24 * 60 * 60);
      }
      return result;
    }
  }

  /**
   * Send a message via SMTP without storing it in the Sent mailbox.
   * Used for scheduled messages that are already stored.
   */
  async sendRaw(message: OutboundMessage): Promise<void> {
    const messageId = message.messageId ?? `<${uuidv4()}@${EMAIL_DOMAIN}>`;
    const nmAttachments = await this.resolveAttachments(message.attachments || []);

    const mailOptions = {
      messageId,
      from: `${message.from.name || ''} <${message.from.address}>`.trim(),
      to: message.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
      cc: message.cc?.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
      bcc: message.bcc?.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
      subject: message.subject,
      text: message.text,
      html: message.html,
      inReplyTo: message.inReplyTo,
      references: message.references?.join(' '),
      attachments: nmAttachments,
      headers: message.requestReadReceipt
        ? { 'Disposition-Notification-To': `${message.from.name || ''} <${message.from.address}>`.trim() }
        : undefined,
      ...SECURE_MAIL_CONTENT_OPTIONS,
    };

    await this.transporter.sendMail(mailOptions);

    logger.info('Scheduled email sent', {
      messageId,
      to: message.to.map((a) => a.address).join(', '),
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

    await this.transporter.sendMail({
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

  // --- Durable retry queue ---

  private async enqueue(message: OutboundMessage & { messageId: string }): Promise<void> {
    await enqueueEmailOutbox({
      userId: message.userId,
      messageId: message.messageId,
      idempotencyKey: message.idempotencyKey,
      payload: {
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
      },
      nextAttemptAt: new Date(Date.now() + SMTP_OUTBOUND_CONFIG.retryDelays[0]),
    });
    logger.warn('Email persisted in durable outbox', { messageId: message.messageId });
  }

  shutdown(): void {
    if (this._transporter) {
      this._transporter.close();
      this._transporter = null;
    }
  }
}

export const smtpOutbound = new SmtpOutboundService();
export default smtpOutbound;
