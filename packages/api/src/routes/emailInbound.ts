/**
 * Email Inbound Webhook Route
 *
 * Receives inbound email from Cloudflare Email Routing via a worker webhook.
 * Replaces the direct SMTP inbound server so the API does not expose or depend
 * on a public port 25 listener.
 *
 * Flow:
 *   1. Cloudflare Email Routing receives email for *@oxy.so
 *   2. Cloudflare Email Worker forwards raw MIME to this webhook
 *   3. This route parses, spam-checks, and stores the message
 *
 * Realtime fan-out is NOT here. It used to be, and that was the bug: a client
 * only ever heard about mail that arrived through this one route. The emit now
 * lives in `services/inboxRealtime.ts`, called from
 * `EmailService.storeIncomingMessage` — the chokepoint every ingest path shares.
 *
 * Security: Authenticated via a shared secret in the Authorization header.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import type { ParsedMail } from 'mailparser';
import { rateLimit } from '../middleware/rateLimiter';
import { asyncHandler } from '../utils/asyncHandler';
import { emailService } from '../services/email.service';
import { spamService } from '../services/spam.service';
import { EMAIL_DOMAIN, extractUsername, extractAliasTag } from '../config/email.config';
import { getEnvVar } from '../config/env';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { logger } from '../utils/logger';

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
        await emailService.storeIncomingMessage({
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
