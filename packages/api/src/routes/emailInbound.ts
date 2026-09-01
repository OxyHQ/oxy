/**
 * Email Inbound Webhook Route
 *
 * Receives inbound email from Cloudflare Email Routing via a worker webhook.
 * Replaces the direct SMTP inbound server (port 25) which is blocked by
 * DigitalOcean.
 *
 * Flow:
 *   1. Cloudflare Email Routing receives email for *@oxy.so
 *   2. Cloudflare Email Worker forwards raw MIME to this webhook
 *   3. This route parses, spam-checks, and stores the message
 *
 * Security: Authenticated via a shared secret in the Authorization header.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { normalizeInlineText } from '@oxyhq/core';
import { and, eq, not, sql } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import type { ParsedMail } from 'mailparser';
import { rateLimit } from '../middleware/rateLimiter';
import { asyncHandler } from '../utils/asyncHandler';
import { emailService } from '../services/email.service';
import { spamService } from '../services/spam.service';
import { EMAIL_DOMAIN, extractUsername, extractAliasTag } from '../config/email.config';
import { getEnvVar } from '../config/env';
import { getDb } from '../config/postgres';
import { mailboxes } from '../db/schema/mailboxes';
import { messages } from '../db/schema/messages';
import { users } from '../db/schema/users';
import { logger } from '../utils/logger';
import { getIO } from '../utils/socket';
import type { EmailNewEvent, EmailUnreadCountEvent } from '../types/socketEvents';

const SNIPPET_MAX_LENGTH = 140;

/**
 * Build a short plain-text snippet from a message body. Prefers `text` when
 * present; otherwise strips tags and entities from `html` with a minimal
 * regex (no new dependency). The result has whitespace collapsed and is
 * trimmed to {@link SNIPPET_MAX_LENGTH} characters.
 */
function buildSnippet(text?: string, html?: string): string {
  const source = text && text.trim().length > 0
    ? text
    : html
      ? html
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
      : '';
  // A snippet is a ONE-LINE preview of a message body written by a third party,
  // so the canonical inline normalizer applies: every line break the sender's
  // markup happened to contain becomes a space. (Clients render it in an RN
  // `Text`, which would otherwise preserve them.)
  const collapsed = normalizeInlineText(source);
  return collapsed.length > SNIPPET_MAX_LENGTH
    ? collapsed.slice(0, SNIPPET_MAX_LENGTH)
    : collapsed;
}

interface StoredIncomingMessage {
  id: string;
  mailboxId: string;
  receivedAt?: Date | string;
  date?: Date | string;
}

/**
 * Resolve the recipient's mailbox folder name for the socket payload. Falls
 * back to `'inbox'` for spam-routed deliveries so clients always receive a
 * meaningful folder hint without an extra round-trip.
 */
function resolveFolder(specialUse: string | null | undefined, mailboxName: string | null | undefined): string {
  if (specialUse === '\\Junk') return 'spam';
  if (specialUse === '\\Inbox') return 'inbox';
  if (typeof mailboxName === 'string' && mailboxName.trim().length > 0) {
    return mailboxName.toLowerCase();
  }
  return 'inbox';
}

/**
 * Fan out real-time inbox events for a freshly stored message. Failures are
 * isolated: if the IO singleton is unavailable or Redis is unhealthy we log a
 * warning and continue so the webhook can still respond 200 to Cloudflare.
 */
async function emitInboxSocketEvents(args: {
  userId: string;
  stored: StoredIncomingMessage;
  fallbackText?: string;
  fallbackHtml?: string;
  senderName: string;
  senderAddress: string;
  subject: string;
}): Promise<void> {
  try {
    const io = getIO();
    if (!io) {
      logger.warn('Inbox socket emit skipped: Socket.IO not initialised');
      return;
    }

    const messageId = args.stored.id;
    if (!messageId) {
      logger.warn('Inbox socket emit skipped: stored message missing id');
      return;
    }

    const mailboxIdStr = args.stored.mailboxId;
    const room = `user:${args.userId}`;

    const [mailbox] = await getDb()
      .select({ name: mailboxes.name, specialUse: mailboxes.specialUse })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxIdStr))
      .limit(1);

    const receivedAtRaw = args.stored.receivedAt ?? args.stored.date ?? new Date();
    const receivedAt = receivedAtRaw instanceof Date
      ? receivedAtRaw.toISOString()
      : new Date(receivedAtRaw).toISOString();

    const snippet = buildSnippet(args.fallbackText, args.fallbackHtml);

    const emailNewPayload: EmailNewEvent = {
      messageId,
      mailboxId: mailboxIdStr,
      folder: resolveFolder(mailbox?.specialUse, mailbox?.name),
      from: args.senderName
        ? { name: args.senderName, address: args.senderAddress }
        : { address: args.senderAddress },
      subject: args.subject,
      snippet,
      receivedAt,
      unread: true,
    };

    io.to(room).emit('email:new', emailNewPayload);

    // The count `mailboxes.unseen_messages` used to cache. The partial index
    // `messages_unseen_idx` (`where not seen`) makes it an index-only scan over
    // just the unread rows.
    const [unreadRow] = await getDb()
      .select({ unread: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.mailboxId, mailboxIdStr), not(messages.seen)));
    const unread = unreadRow?.unread ?? 0;

    const unreadPayload: EmailUnreadCountEvent = {
      mailboxId: mailboxIdStr,
      unread,
    };

    io.to(room).emit('email:unread_count', unreadPayload);
  } catch (err) {
    logger.warn('Inbox socket emit failed', {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const router = Router();

const INBOUND_WEBHOOK_SECRET = getEnvVar('EMAIL_INBOUND_WEBHOOK_SECRET', '');

// Rate limit: 60 authenticated emails per minute (generous for inbound webhook).
// Mounted in server.ts after shared-secret verification so unauthenticated
// traffic cannot consume Cloudflare Email Routing's delivery quota.
export const inboundRateLimit = rateLimit({
  prefix: 'rl:email:inbound:',
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: () => 'email-inbound-global',
  message: 'Too many inbound emails, please try again later.',
});

/**
 * Verify the webhook secret from the Authorization header.
 */
function constantTimeEquals(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;

  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function verifyEmailInboundWebhookSecret(req: Request, res: Response, next: NextFunction): void {
  if (!INBOUND_WEBHOOK_SECRET) {
    logger.error('EMAIL_INBOUND_WEBHOOK_SECRET is not configured');
    res.status(500).json({ error: 'Webhook not configured' });
    return;
  }

  const authHeader = req.headers.authorization ?? '';
  const providedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
  if (!constantTimeEquals(providedSecret, INBOUND_WEBHOOK_SECRET)) {
    res.status(401).json({ error: 'Invalid webhook secret' });
    return;
  }

  next();
}

/**
 * POST /email/inbound
 *
 * Accepts raw RFC 5322 MIME email as the request body.
 * Content-Type should be message/rfc822 or application/octet-stream.
 *
 * Headers:
 *   Authorization: Bearer <EMAIL_INBOUND_WEBHOOK_SECRET>
 *   X-Envelope-From: sender@example.com (optional, from SMTP MAIL FROM)
 *   X-Envelope-To: recipient@oxy.so (comma-separated if multiple)
 */
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    // `req.body` is a Buffer only because `server.ts` mounts `express.raw` on
    // this path AHEAD of the global JSON parser. That is configuration, not a
    // type guarantee, so the runtime shape is checked here rather than asserted
    // with a cast:
    //   - body-parser's `raw` assigns `{}`, not an empty Buffer, for a request
    //     that carries no body at all — a shape reachable TODAY, on which
    //     `.length` is `undefined` and the empty-body guard silently passes.
    //   - if the parser ordering ever drifts (AGENTS.md calls this out), the
    //     JSON parser wins and hands this handler a parsed object or array.
    //     An array even has a plausible `.length`, so the message would flow on
    //     to the spam check and `simpleParser` as a non-Buffer.
    const rawMessage: unknown = req.body;
    if (!Buffer.isBuffer(rawMessage)) {
      // Loud, because the silent-failure mode this replaces is exactly the one
      // AGENTS.md warns about: inbound mail disappearing with a 400 nobody reads.
      logger.error('Inbound webhook: body is not a Buffer — raw body parser did not run', undefined, {
        bodyType: Array.isArray(rawMessage) ? 'array' : typeof rawMessage,
      });
      return res.status(400).json({ error: 'Empty message body' });
    }
    if (rawMessage.length === 0) {
      return res.status(400).json({ error: 'Empty message body' });
    }

    // Extract envelope recipients from header (set by Cloudflare Worker)
    const envelopeTo = (req.headers['x-envelope-to'] as string || '')
      .split(',')
      .map((addr) => addr.trim().toLowerCase())
      .filter(Boolean);

    if (envelopeTo.length === 0) {
      return res.status(400).json({ error: 'Missing X-Envelope-To header' });
    }

    // Validate at least one recipient exists
    const validRecipients: Array<{ address: string; username: string; userId: string; aliasTag?: string }> = [];
    for (const addr of envelopeTo) {
      const username = extractUsername(addr);
      if (!username) continue;

      // `lower(btrim(username))`, matching `users_lower_username_key`.
      const [user] = await getDb()
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
        .limit(1);
      if (!user) {
        logger.info('Inbound webhook: recipient not found', { address: addr });
        continue;
      }

      validRecipients.push({
        address: addr,
        username,
        userId: user.id,
        aliasTag: extractAliasTag(addr) ?? undefined,
      });
    }

    if (validRecipients.length === 0) {
      return res.status(400).json({ error: 'No valid recipients found' });
    }

    // Spam check (if Rspamd is available)
    const spamResult = await spamService.check(rawMessage);
    if (spamService.shouldReject(spamResult.score)) {
      logger.info('Inbound webhook: rejected spam', {
        score: spamResult.score,
        from: req.headers['x-envelope-from'],
      });
      return res.status(400).json({ error: 'Message rejected as spam' });
    }

    // Parse MIME
    const parsed: ParsedMail = await simpleParser(rawMessage);

    const fromAddr = parsed.from?.value?.[0];
    const toAddrs = (parsed.to && !Array.isArray(parsed.to) ? [parsed.to] : parsed.to || [])
      .flatMap((addr) => addr.value);
    const ccAddrs = (parsed.cc && !Array.isArray(parsed.cc) ? [parsed.cc] : parsed.cc || [])
      .flatMap((addr) => addr.value);

    // Convert attachments
    const attachments = (parsed.attachments || []).map((att) => ({
      filename: att.filename || 'attachment',
      contentType: att.contentType || 'application/octet-stream',
      content: att.content,
      contentId: att.contentId,
      isInline: att.contentDisposition === 'inline',
    }));

    // Extract headers
    const headersObj: Record<string, string> = {};
    if (parsed.headers) {
      parsed.headers.forEach((value, key) => {
        headersObj[key] = typeof value === 'string' ? value : JSON.stringify(value);
      });
    }

    const envelopeFrom = (req.headers['x-envelope-from'] as string || '').toLowerCase();
    const senderAddress = fromAddr?.address || envelopeFrom;

    // Deliver to each valid recipient
    const results: Array<{ recipient: string; status: string }> = [];
    for (const rcpt of validRecipients) {
      try {
        const stored = await emailService.storeIncomingMessage({
          recipientUsername: rcpt.username,
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
          aliasTag: rcpt.aliasTag,
          rawSize: rawMessage.length,
        });

        results.push({ recipient: rcpt.address, status: 'delivered' });
        logger.info('Inbound webhook: message delivered', {
          from: senderAddress,
          to: rcpt.address,
          subject: parsed.subject,
        });

        await emitInboxSocketEvents({
          userId: rcpt.userId,
          stored,
          fallbackText: parsed.text,
          fallbackHtml: typeof parsed.html === 'string' ? parsed.html : undefined,
          senderName: fromAddr?.name || '',
          senderAddress,
          subject: parsed.subject || '',
        });
      } catch (err) {
        logger.error('Inbound webhook: delivery failed', err instanceof Error ? err : new Error(String(err)), {
          recipient: rcpt.address,
        });
        results.push({ recipient: rcpt.address, status: 'failed' });
      }
    }

    res.status(200).json({
      accepted: results.filter((r) => r.status === 'delivered').length,
      rejected: results.filter((r) => r.status === 'failed').length,
      results,
    });
  })
);

export default router;
