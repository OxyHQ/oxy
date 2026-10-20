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
import { rateLimit } from '../middleware/rateLimiter';
import { asyncHandler } from '../utils/asyncHandler';
import { emailService } from '../services/email.service';
import { fallbackMessageId, parseInboundMime } from '../services/inboundMime';
import { spamService } from '../services/spam.service';
import { extractUsername, extractAliasTag } from '../config/email.config';
import { getEnvVar } from '../config/env';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { BadRequestError, NotFoundError } from '../utils/error';
import { logger } from '../utils/logger';
import { mapWithConcurrency } from '../utils/mapWithConcurrency';

const router = Router();

const INBOUND_WEBHOOK_SECRET = getEnvVar('EMAIL_INBOUND_WEBHOOK_SECRET', '');

/**
 * Accounts one envelope is delivered to at a time. A list message to a dozen
 * Oxy users used to be stored one recipient after another inside the
 * webhook's request, each delivery a dozen round trips plus its uploads.
 */
const INBOUND_DELIVERY_CONCURRENCY = 4;

/** An envelope recipient that resolved to an Oxy account. */
interface ValidRecipient {
  address: string;
  username: string;
  userId: string;
  aliasTag?: string;
}

/**
 * The envelope recipients of an inbound request, as one rate-limit key:
 * lower-cased, trimmed, de-duplicated and sorted, so the same recipients are
 * the same bucket however the header spells them. The worker sends one
 * recipient per request (Cloudflare invokes it once per RCPT TO).
 */
export function envelopeRecipientsKey(req: Request): string {
  const header = req.headers['x-envelope-to'];
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const recipients = [
    ...new Set(
      raw
        .split(',')
        .map((addr) => addr.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
  // A request without one is answered 400 by the route; it still counts.
  return recipients.length > 0 ? recipients.join(',') : 'no-envelope-recipient';
}

// Mounted in server.ts after shared-secret verification so unauthenticated
// traffic cannot consume Cloudflare Email Routing's delivery quota. A refusal
// is a 429, which the worker (`workers/email-inbound`) retries rather than
// bouncing.
//
// The budget used to be 60 a minute for the WHOLE platform, so one busy
// mailing list delayed every other user's mail with it. It is now per
// recipient, with a platform-wide backstop well above any one recipient.
const inboundRecipientRateLimit = rateLimit({
  prefix: 'rl:email:inbound:rcpt:',
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: envelopeRecipientsKey,
  message: 'Too many inbound emails for this recipient, please try again later.',
});

const inboundGlobalRateLimit = rateLimit({
  prefix: 'rl:email:inbound:',
  windowMs: 60 * 1000,
  max: 6000,
  keyGenerator: () => 'email-inbound-global',
  message: 'Too many inbound emails, please try again later.',
});

/**
 * Both inbound budgets, the recipient's own first: a flood refused there is
 * not also charged to the backstop every other recipient shares.
 */
export const inboundRateLimit = [inboundRecipientRateLimit, inboundGlobalRateLimit];

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

export function verifyEmailInboundWebhookSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
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
      logger.error(
        'Inbound webhook: body is not a Buffer — raw body parser did not run',
        undefined,
        {
          bodyType: Array.isArray(rawMessage) ? 'array' : typeof rawMessage,
        },
      );
      return res.status(400).json({ error: 'Empty message body' });
    }
    if (rawMessage.length === 0) {
      return res.status(400).json({ error: 'Empty message body' });
    }

    // Extract envelope recipients from header (set by Cloudflare Worker),
    // each once: a repeated address would be delivered, and reported, twice.
    const envelopeTo = [
      ...new Set(
        ((req.headers['x-envelope-to'] as string) || '')
          .split(',')
          .map((addr) => addr.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];

    if (envelopeTo.length === 0) {
      return res.status(400).json({ error: 'Missing X-Envelope-To header' });
    }

    // Validate at least one recipient exists. The lookups are independent, so
    // they run side by side; the list keeps the envelope's order.
    const lookups = await mapWithConcurrency(
      envelopeTo,
      INBOUND_DELIVERY_CONCURRENCY,
      async (addr): Promise<ValidRecipient | null> => {
        const username = extractUsername(addr);
        if (!username) return null;

        // `lower(btrim(username))`, matching `users_lower_username_key`.
        const [user] = await getDb()
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
          .limit(1);
        if (!user) {
          logger.info('Inbound webhook: recipient not found', { address: addr });
          return null;
        }

        return {
          address: addr,
          username,
          userId: user.id,
          aliasTag: extractAliasTag(addr) ?? undefined,
        };
      },
    );
    const validRecipients = lookups.filter((rcpt): rcpt is ValidRecipient => rcpt !== null);

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

    // Parse MIME — the one parser every ingest path shares.
    const mime = await parseInboundMime(rawMessage);

    const envelopeFrom = ((req.headers['x-envelope-from'] as string) || '').toLowerCase();
    const senderAddress = mime.from?.address || envelopeFrom;

    // Deliver to each valid recipient, up to INBOUND_DELIVERY_CONCURRENCY
    // accounts at a time. The addresses of ONE account (`bob+a@`, `bob+b@`)
    // stay one after another: the second must find the first's copy by its
    // Message-ID, not race it to an insert. `results` keeps the envelope's
    // order whatever order the deliveries finish in.
    const results = new Array<{ recipient: string; status: string }>(validRecipients.length);
    let transientFailure = false;
    const deliver = async (
      rcpt: ValidRecipient,
    ): Promise<{ recipient: string; status: string }> => {
      try {
        await emailService.storeIncomingMessage({
          recipientUsername: rcpt.username,
          from: {
            name: mime.from?.name || '',
            address: senderAddress,
          },
          replyTo: mime.replyTo,
          to: mime.to,
          cc: mime.cc,
          subject: mime.subject,
          text: mime.text,
          html: mime.html,
          messageId: mime.messageId || fallbackMessageId(rawMessage),
          inReplyTo: mime.inReplyTo,
          references: mime.references,
          date: mime.date || new Date(),
          headers: mime.headers,
          attachments: mime.attachments,
          spamScore: spamResult.score,
          spamAction: spamResult.action,
          aliasTag: rcpt.aliasTag,
          rawSize: rawMessage.length,
        });

        logger.info('Inbound webhook: message delivered', {
          from: senderAddress,
          to: rcpt.address,
          subject: mime.subject,
        });
        return { recipient: rcpt.address, status: 'delivered' };
      } catch (err) {
        // A refusal the service repeats on every attempt — over quota, an
        // attachment it will not store, a recipient deleted since the lookup
        // above — is permanent. Anything else (the database, S3) may succeed
        // on a retry.
        const permanent = err instanceof BadRequestError || err instanceof NotFoundError;
        if (!permanent) transientFailure = true;
        logger.error(
          'Inbound webhook: delivery failed',
          err instanceof Error ? err : new Error(String(err)),
          {
            recipient: rcpt.address,
            permanent,
          },
        );
        return { recipient: rcpt.address, status: 'failed' };
      }
    };

    const byAccount = new Map<string, number[]>();
    validRecipients.forEach((rcpt, index) => {
      const indexes = byAccount.get(rcpt.userId);
      if (indexes) indexes.push(index);
      else byAccount.set(rcpt.userId, [index]);
    });
    await mapWithConcurrency(
      [...byAccount.values()],
      INBOUND_DELIVERY_CONCURRENCY,
      async (indexes) => {
        for (const index of indexes) results[index] = await deliver(validRecipients[index]);
      },
    );

    // The worker (`workers/email-inbound`) retries a 5xx and bounces any other
    // 4xx to the sender. A retry redelivers to every recipient; the ones that
    // already have the message are answered with their stored copy
    // (`storeIncomingMessage` matches it by Message-ID), so only the failed
    // ones are stored again.
    const failed = results.some((r) => r.status === 'failed');
    const status = !failed ? 200 : transientFailure ? 503 : 422;

    res.status(status).json({
      accepted: results.filter((r) => r.status === 'delivered').length,
      rejected: results.filter((r) => r.status === 'failed').length,
      results,
    });
  }),
);

export default router;
