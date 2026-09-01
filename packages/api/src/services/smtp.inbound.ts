/**
 * SMTP Inbound Server
 *
 * Receives incoming email from the internet using the `smtp-server` library.
 * Validates recipients against Oxy users, runs spam checks via Rspamd,
 * parses MIME with `mailparser`, and stores messages through the email service.
 */

import { SMTPServer, type SMTPServerSession, type SMTPServerAddress, type SMTPServerDataStream } from 'smtp-server';
import { simpleParser, type ParsedMail } from 'mailparser';
import { sql } from 'drizzle-orm';
import { SMTP_INBOUND_CONFIG, EMAIL_DOMAIN, extractUsername, extractAliasTag } from '../config/email.config';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { emailService } from './email.service';
import { spamService } from './spam.service';
import { logger } from '../utils/logger';
import fs from 'fs';

let smtpServer: SMTPServer | null = null;

/**
 * The account a `RCPT TO` address belongs to, or `null` when there is none.
 *
 * Extracted from the `onRcptTo` handler so the lookup this SMTP server accepts
 * or rejects mail on is reachable without booting a TLS listener — the handler
 * itself is a closure inside `new SMTPServer({...})` and `startSmtpInbound`
 * refuses to run without readable certificates.
 *
 * The match is written `lower(btrim(username)) = lower(btrim($1))`, the
 * EXPRESSION `users_lower_username_key` is built on and the same spelling the
 * Cloudflare-webhook path uses (`routes/emailInbound.ts`). Mongo compared
 * `{ username }` for exact equality against a lower-cased address, so mail to
 * `Nate@oxy.so` was rejected for an account stored as `Nate` while the webhook
 * path delivered it — the two inbound routes now agree.
 *
 * Only `id` is selected. `users` is in `db/schema/protectedColumns.ts`, and a
 * bare `select()` here would pull the raw phone, the contact-discovery hashes
 * and the refresh token into an SMTP handler.
 */
export async function findRecipientAccountId(emailAddress: string): Promise<string | null> {
  const username = extractUsername(emailAddress.toLowerCase());
  if (!username) {
    return null;
  }

  const [account] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
    .limit(1);

  return account?.id ?? null;
}

/**
 * Create and start the SMTP inbound server.
 */
export function startSmtpInbound(): SMTPServer {
  let tlsOptions: {
    key: Buffer; cert: Buffer; minVersion: 'TLSv1.2'; ciphers: string; sigalgs: string;
  } | undefined;

  if (SMTP_INBOUND_CONFIG.tls.key && SMTP_INBOUND_CONFIG.tls.cert) {
    try {
      tlsOptions = {
        key: fs.readFileSync(SMTP_INBOUND_CONFIG.tls.key),
        cert: fs.readFileSync(SMTP_INBOUND_CONFIG.tls.cert),
        minVersion: 'TLSv1.2' as const,
        ciphers: [
          'ECDHE-ECDSA-AES256-GCM-SHA384',
          'ECDHE-RSA-AES256-GCM-SHA384',
          'ECDHE-ECDSA-AES128-GCM-SHA256',
          'ECDHE-RSA-AES128-GCM-SHA256',
          'DHE-RSA-AES256-GCM-SHA384',
          'DHE-RSA-AES128-GCM-SHA256',
        ].join(':'),
        // Keep STARTTLS on forward-secret TLS 1.2+ suites and SHA-256+ signatures.
        sigalgs: [
          'ecdsa_secp256r1_sha256',
          'ecdsa_secp384r1_sha384',
          'rsa_pss_rsae_sha256',
          'rsa_pss_rsae_sha384',
          'rsa_pss_rsae_sha512',
          'rsa_pkcs1_sha256',
          'rsa_pkcs1_sha384',
          'rsa_pkcs1_sha512',
        ].join(':'),
      };
    } catch (err) {
      logger.error('SMTP TLS certs could not be loaded; refusing to start plaintext SMTP inbound', {
        keyPath: SMTP_INBOUND_CONFIG.tls.key,
        certPath: SMTP_INBOUND_CONFIG.tls.cert,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!tlsOptions) {
    throw new Error('SMTP inbound requires readable SMTP_TLS_KEY and SMTP_TLS_CERT to advertise STARTTLS');
  }

  smtpServer = new SMTPServer({
    name: EMAIL_DOMAIN,
    banner: SMTP_INBOUND_CONFIG.banner,
    size: SMTP_INBOUND_CONFIG.maxMessageSize,
    disabledCommands: ['AUTH'],
    authOptional: true,
    secure: false,
    ...tlsOptions,

    /**
     * Validate RCPT TO addresses — reject if the user doesn't exist.
     */
    async onRcptTo(
      address: SMTPServerAddress,
      _session: SMTPServerSession,
      callback: (err?: Error | null) => void
    ) {
      try {
        const emailAddr = address.address.toLowerCase();

        if (!extractUsername(emailAddr)) {
          return callback(new Error(`550 Recipient rejected: not our domain`));
        }

        const accountId = await findRecipientAccountId(emailAddr);
        if (!accountId) {
          return callback(new Error(`550 Recipient not found: ${emailAddr}`));
        }

        callback();
      } catch (error) {
        logger.error('SMTP RCPT TO error', error instanceof Error ? error : new Error(String(error)));
        callback(new Error('451 Temporary error, try again later'));
      }
    },

    /**
     * Process the incoming message data.
     */
    async onData(
      stream: SMTPServerDataStream,
      session: SMTPServerSession,
      callback: (err?: Error | null) => void
    ) {
      try {
        // Collect the raw message into a buffer
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const rawMessage = Buffer.concat(chunks);

        // Spam check
        const spamResult = await spamService.check(rawMessage);
        if (spamService.shouldReject(spamResult.score)) {
          logger.info('Rejected spam message', {
            score: spamResult.score,
            from: session.envelope.mailFrom,
          });
          return callback(new Error('550 Message rejected as spam'));
        }

        // Parse MIME
        const parsed: ParsedMail = await simpleParser(rawMessage);

        // Deliver to each recipient
        const recipients = session.envelope.rcptTo || [];
        for (const rcpt of recipients) {
          const recipientAddr = rcpt.address.toLowerCase();
          const username = extractUsername(recipientAddr);
          if (!username) continue;

          const aliasTag = extractAliasTag(recipientAddr);

          const fromAddr = parsed.from?.value?.[0];
          const toAddrs = (parsed.to && !Array.isArray(parsed.to) ? [parsed.to] : parsed.to || [])
            .flatMap((addr) => addr.value);
          const ccAddrs = (parsed.cc && !Array.isArray(parsed.cc) ? [parsed.cc] : parsed.cc || [])
            .flatMap((addr) => addr.value);

          // Convert mailparser attachments
          const attachments = (parsed.attachments || []).map((att) => ({
            filename: att.filename || 'attachment',
            contentType: att.contentType || 'application/octet-stream',
            content: att.content,
            contentId: att.contentId,
            isInline: att.contentDisposition === 'inline',
          }));

          const headersObj: Record<string, string> = {};
          if (parsed.headers) {
            parsed.headers.forEach((value, key) => {
              headersObj[key] = typeof value === 'string' ? value : JSON.stringify(value);
            });
          }

          const mailFrom = session.envelope.mailFrom as { address: string } | false;
          const senderAddress = fromAddr?.address || (mailFrom ? mailFrom.address : '');
          await emailService.storeIncomingMessage({
            recipientUsername: username,
            from: {
              name: fromAddr?.name || '',
              address: senderAddress,
            },
            to: toAddrs.map((a) => ({ name: a.name || '', address: a.address || '' })),
            cc: ccAddrs.map((a) => ({ name: a.name || '', address: a.address || '' })),
            subject: parsed.subject || '',
            text: parsed.text,
            html: typeof parsed.html === 'string' ? parsed.html : undefined,
            messageId: parsed.messageId || `<${Date.now()}@${EMAIL_DOMAIN}>`,
            inReplyTo: parsed.inReplyTo || undefined,
            references: Array.isArray(parsed.references)
              ? parsed.references
              : parsed.references
                ? [parsed.references]
                : [],
            date: parsed.date || new Date(),
            headers: headersObj,
            attachments,
            spamScore: spamResult.score,
            spamAction: spamResult.action,
            aliasTag: aliasTag ?? undefined,
            rawSize: rawMessage.length,
          });
        }

        callback();
      } catch (error) {
        logger.error('SMTP data processing error', error instanceof Error ? error : new Error(String(error)));
        callback(new Error('451 Message processing failed'));
      }
    },

  });

  smtpServer.on('error', (err: Error) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === 'ERR_SSL_NO_SUITABLE_SIGNATURE_ALGORITHM' ||
      code === 'ECONNRESET' ||
      err.message?.includes('SSL routines')
    ) {
      logger.warn('SMTP TLS handshake issue', { code, message: err.message });
    } else {
      logger.error('SMTP server error', err);
    }
  });

  smtpServer.listen(SMTP_INBOUND_CONFIG.port, SMTP_INBOUND_CONFIG.host, () => {
    logger.info('SMTP inbound server started', {
      port: SMTP_INBOUND_CONFIG.port,
      host: SMTP_INBOUND_CONFIG.host,
    });
  });

  return smtpServer;
}

/**
 * Gracefully shut down the SMTP server.
 */
export function stopSmtpInbound(): Promise<void> {
  return new Promise((resolve) => {
    if (smtpServer) {
      smtpServer.close(() => {
        logger.info('SMTP inbound server stopped');
        smtpServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}
