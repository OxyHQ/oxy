/**
 * Bounce and complaint ingestion.
 *
 * Two providers, one destination. SES speaks Amazon SNS; Brevo posts a plain
 * signed webhook. Both normalise into `email_suppressions`, so the send path
 * has exactly one thing to check regardless of which relay is in front today —
 * which matters, because the relay is expected to change and to fail over.
 *
 * ## Authenticity is not optional here
 *
 * Every row written from this route removes someone's ability to email an
 * address. An unauthenticated endpoint would be a denial-of-service primitive:
 * post a few thousand fabricated bounces and the platform stops talking to
 * whoever you name. So:
 *
 *  - SNS messages are verified against the signing certificate Amazon names in
 *    the payload, and that certificate URL is itself constrained to an Amazon
 *    host — a payload that points the verifier at an attacker's certificate is
 *    the whole attack, and a naive implementation follows it.
 *  - Brevo posts carry a shared secret compared in constant time.
 *
 * Mounted BEFORE the authenticated `/email` router (see `server.ts`), because
 * neither provider carries an Oxy session.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createVerify, timingSafeEqual } from 'node:crypto';
import { rateLimit } from '../middleware/rateLimiter';
import { asyncHandler } from '../utils/asyncHandler';
import { getEnvVar } from '../config/env';
import { logger } from '../utils/logger';
import { recordSuppression } from '../services/emailSuppression.service';
import type { EmailSuppressionReason } from '../db/schema/emailSuppressions';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { sql } from 'drizzle-orm';
import { extractUsername } from '../config/email.config';

const router = Router();

const BREVO_WEBHOOK_SECRET = getEnvVar('BREVO_WEBHOOK_SECRET', '');
/**
 * Refuse anything arriving with a cookie.
 *
 * Neither SNS nor Brevo sends one. A request that does is a browser, which is
 * the shape CSRF describes. Rejecting cookie-bearing requests outright keeps
 * this endpoint out of reach of a user's credentials, so there is no session
 * for a cross-site request to ride even if the API ever sets a cookie again.
 */
function rejectCookieAuthenticatedRequests(req: Request, res: Response, next: NextFunction): void {
  if (req.headers.cookie) {
    logger.warn('Email feedback request rejected: arrived with cookies');
    res.status(403).json({ error: 'This endpoint does not accept cookie-authenticated requests' });
    return;
  }
  next();
}

router.use(rejectCookieAuthenticatedRequests);



export const feedbackRateLimit = rateLimit({
  prefix: 'rl:email:feedback:',
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: () => 'email-feedback-global',
  message: 'Too many feedback notifications, please try again later.',
});

// ─── SNS (Amazon SES) ────────────────────────────────────────────────────────

/**
 * Hosts whose certificates may sign an SNS message.
 *
 * Amazon publishes signing certificates under `sns.<region>.amazonaws.com`. The
 * payload tells you where to fetch the certificate, and trusting that field
 * verbatim is the classic SNS forgery: the signature then checks out against a
 * key the attacker owns. Pin the host shape instead.
 */
export function isAmazonSigningCertUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  // Credentials in the URL would be sent to the host; SNS never uses them.
  if (url.username || url.password) return false;

  // Compared label by label against constants rather than matched with a
  // pattern. `sns.us-west-2.amazonaws.com.evil.example.com` ends with the right
  // characters and a careless `endsWith` accepts it; only fixing the POSITION
  // of every label rejects it.
  const labels = url.hostname.toLowerCase().split('.');
  const suffix = labels.slice(-2).join('.') === 'amazonaws.com'
    ? labels.slice(0, -2)
    : labels.slice(-3).join('.') === 'amazonaws.com.cn'
      ? labels.slice(0, -3)
      : null;
  if (suffix === null) return false;

  // Exactly `sns.<region>` in front of it — no deeper subdomain.
  return suffix.length === 2 && suffix[0] === 'sns' && REGION_LABEL.test(suffix[1]);
}

/** An AWS region label: `us-west-2`, `eu-central-1`, `ap-southeast-4`. */
const REGION_LABEL = /^[a-z]{2,4}(-[a-z]+)+-\d$/;

export interface SnsEnvelope {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  Token?: string;
  SubscribeURL?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
}

/**
 * The canonical string SNS signs: a fixed field order per message type, each
 * field as `name\nvalue\n`. Absent optional fields are skipped. Getting the
 * order wrong makes every signature fail; inventing a field makes every
 * signature pass for the wrong reason.
 */
export function snsStringToSign(msg: SnsEnvelope): string | null {
  const fields = msg.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation'
      ? ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
      : null;
  if (!fields) return null;

  let out = '';
  for (const field of fields) {
    const value = (msg as Record<string, unknown>)[field];
    if (typeof value !== 'string') continue; // Subject is genuinely optional.
    out += `${field}\n${value}\n`;
  }
  return out;
}

/**
 * Fetch a URL that MUST be an Amazon SNS endpoint.
 *
 * Both outbound requests this route makes — the signing certificate and the
 * subscription confirmation — take their URL from the request body. That is a
 * server-side request forgery primitive unless the host is constrained, and
 * "the signature covered the field" is not a sufficient answer on its own,
 * because the signature is only trustworthy once the certificate has already
 * been fetched from somewhere. One function, one allowlist, no ordering to get
 * wrong.
 */
// `Response` here is Express's, so name the fetch one structurally.
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

async function fetchAmazonUrl(url: string): Promise<FetchResponse | null> {
  if (!isAmazonSigningCertUrl(url)) {
    logger.warn('Refused an SNS fetch to a non-Amazon host');
    return null;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    return response.ok ? response : null;
  } catch (err) {
    logger.warn('SNS fetch failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

const certCache = new Map<string, string>();

async function fetchSigningCert(url: string): Promise<string | null> {
  // Re-checked HERE rather than only at the call site. The guard and the
  // request it guards belong next to each other: a future caller that forgets
  // the check would otherwise turn this into a server-side request forgery
  // primitive, with the payload choosing the host.
  if (!isAmazonSigningCertUrl(url)) return null;
  const cached = certCache.get(url);
  if (cached) return cached;
  const response = await fetchAmazonUrl(url);
  if (!response) return null;
  if (!response.ok) return null;
  const pem = await response.text();
  if (!pem.includes('BEGIN CERTIFICATE')) return null;
  // Bounded: the URL is already pinned to an Amazon host, and Amazon rotates
  // through a small set.
  if (certCache.size > 16) certCache.clear();
  certCache.set(url, pem);
  return pem;
}

async function verifySnsSignature(msg: SnsEnvelope): Promise<boolean> {
  if (!msg.Signature || !msg.SigningCertURL) return false;
  if (!isAmazonSigningCertUrl(msg.SigningCertURL)) {
    logger.warn('SNS message rejected: signing certificate URL is not an Amazon host');
    return false;
  }
  const stringToSign = snsStringToSign(msg);
  if (stringToSign === null) return false;

  const pem = await fetchSigningCert(msg.SigningCertURL);
  if (!pem) return false;

  const algorithm = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  try {
    const verifier = createVerify(algorithm);
    verifier.update(stringToSign, 'utf8');
    return verifier.verify(pem, msg.Signature, 'base64');
  } catch (err) {
    logger.warn('SNS signature verification threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** The SES notification bodies this route understands. */
interface SesNotification {
  notificationType?: string;
  eventType?: string;
  mail?: { source?: string; destination?: string[] };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: Array<{ emailAddress?: string; diagnosticCode?: string; status?: string }>;
    timestamp?: string;
  };
  complaint?: {
    complainedRecipients?: Array<{ emailAddress?: string }>;
    complaintFeedbackType?: string;
    timestamp?: string;
  };
}

/**
 * The address out of a `Name <user@host>` header, or the whole string when
 * there are no angle brackets.
 *
 * Deliberately not a regex. `source` is an envelope header a third party wrote,
 * and `/<([^>]+)>/` backtracks quadratically on input like `<<<<<<<…` — a free
 * denial of service on an endpoint anyone can POST to. `indexOf` cannot.
 */
export function extractAngleAddress(source: string): string {
  const open = source.indexOf('<');
  const close = open === -1 ? -1 : source.indexOf('>', open + 1);
  return (close > open ? source.slice(open + 1, close) : source).trim().toLowerCase();
}

/**
 * Which Oxy account sent a message, from its envelope `From`. A complaint is
 * scoped to the sender; when we cannot resolve one, the complaint is DROPPED
 * rather than applied globally — blocking an address for every user because one
 * unidentifiable sender was reported is worse than losing the signal.
 */
async function resolveSenderUserId(source: string | undefined): Promise<string | null> {
  if (!source) return null;
  const address = extractAngleAddress(source);
  const username = extractUsername(address);
  if (!username) return null;
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
    .limit(1);
  return row?.id ?? null;
}

async function applySesNotification(notification: SesNotification): Promise<number> {
  const kind = notification.notificationType ?? notification.eventType;
  let applied = 0;

  if (kind === 'Bounce' && notification.bounce) {
    // SES says `Permanent` or `Transient`. Treating a full mailbox as permanent
    // would blocklist a perfectly good address forever.
    const reason: EmailSuppressionReason =
      notification.bounce.bounceType === 'Permanent' ? 'bounce_permanent' : 'bounce_transient';
    const reportedAt = notification.bounce.timestamp
      ? new Date(notification.bounce.timestamp)
      : new Date();
    for (const recipient of notification.bounce.bouncedRecipients ?? []) {
      if (!recipient.emailAddress) continue;
      await recordSuppression({
        address: recipient.emailAddress,
        reason,
        source: 'ses',
        diagnostic: recipient.diagnosticCode ?? recipient.status ?? notification.bounce.bounceSubType ?? null,
        reportedAt,
        userId: null, // A bounce is a property of the address, not of the sender.
      });
      applied++;
    }
    return applied;
  }

  if (kind === 'Complaint' && notification.complaint) {
    const senderUserId = await resolveSenderUserId(notification.mail?.source);
    if (!senderUserId) {
      logger.warn('SES complaint dropped: sender could not be resolved to an Oxy account');
      return 0;
    }
    const reportedAt = notification.complaint.timestamp
      ? new Date(notification.complaint.timestamp)
      : new Date();
    for (const recipient of notification.complaint.complainedRecipients ?? []) {
      if (!recipient.emailAddress) continue;
      await recordSuppression({
        address: recipient.emailAddress,
        reason: 'complaint',
        source: 'ses',
        diagnostic: notification.complaint.complaintFeedbackType ?? null,
        reportedAt,
        userId: senderUserId,
      });
      applied++;
    }
    return applied;
  }

  return 0;
}

/**
 * `POST /email/feedback/ses` — an SNS topic subscribed to SES bounce and
 * complaint notifications.
 *
 * Always answers 200 once the signature checks out, even when the body carries
 * nothing we act on. SNS retries a non-2xx and eventually disables the
 * subscription, which would silently stop all bounce handling.
 */
router.post(
  '/ses',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as SnsEnvelope;

    if (!(await verifySnsSignature(body))) {
      logger.warn('SNS message rejected: signature verification failed');
      res.status(403).json({ error: 'Invalid signature' });
      return;
    }

    if (body.Type === 'SubscriptionConfirmation' && body.SubscribeURL) {
      // The signature above covers SubscribeURL, but the host is constrained
      // anyway: a signature is only as good as the certificate it was checked
      // against, and this keeps the two independent.
      const confirmed = await fetchAmazonUrl(body.SubscribeURL);
      logger.info('SNS subscription confirmation', { ok: Boolean(confirmed), topic: body.TopicArn });
      res.status(200).json({ confirmed: Boolean(confirmed) });
      return;
    }

    if (body.Type !== 'Notification' || typeof body.Message !== 'string') {
      res.status(200).json({ applied: 0 });
      return;
    }

    let notification: SesNotification;
    try {
      notification = JSON.parse(body.Message) as SesNotification;
    } catch {
      logger.warn('SNS notification carried a non-JSON Message');
      res.status(200).json({ applied: 0 });
      return;
    }

    const applied = await applySesNotification(notification);
    logger.info('SES feedback processed', {
      kind: notification.notificationType ?? notification.eventType,
      applied,
    });
    res.status(200).json({ applied });
  }),
);

// ─── Brevo ───────────────────────────────────────────────────────────────────

interface BrevoEvent {
  event?: string;
  email?: string;
  reason?: string;
  subject?: string;
  date?: string;
  ts?: number;
}

/**
 * `POST /email/feedback/brevo` — Brevo transactional webhook.
 *
 * Brevo does not sign its webhooks, so the shared secret travels in the path
 * the user configures (`?token=`) and is compared in constant time. Without a
 * configured secret the route refuses everything rather than accepting
 * anonymous suppressions.
 */
router.post(
  '/brevo',
  asyncHandler(async (req: Request, res: Response) => {
    const provided = typeof req.query.token === 'string' ? req.query.token : '';
    if (!BREVO_WEBHOOK_SECRET) {
      logger.error('Brevo webhook received but BREVO_WEBHOOK_SECRET is not configured');
      res.status(503).json({ error: 'Webhook not configured' });
      return;
    }
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(BREVO_WEBHOOK_SECRET, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    const event = req.body as BrevoEvent;
    const address = event.email;
    if (!address) {
      res.status(200).json({ applied: 0 });
      return;
    }

    // Brevo's transactional event names. `hard_bounce` and `blocked` are
    // permanent; `soft_bounce` and `deferred` are not.
    const reason: EmailSuppressionReason | null =
      event.event === 'hard_bounce' || event.event === 'blocked' || event.event === 'invalid_email'
        ? 'bounce_permanent'
        : event.event === 'soft_bounce' || event.event === 'deferred'
          ? 'bounce_transient'
          : event.event === 'spam' || event.event === 'complaint'
            ? 'complaint'
            : null;

    if (!reason) {
      res.status(200).json({ applied: 0 });
      return;
    }

    // Brevo does not tell us which of our users sent it, so a complaint cannot
    // be scoped. Record it as a permanent bounce instead of a global complaint:
    // the table refuses an unscoped complaint precisely so this case has to be
    // decided rather than fudged, and "stop sending to this address" is the
    // conservative reading that still protects the domain.
    const effectiveReason: EmailSuppressionReason =
      reason === 'complaint' ? 'bounce_permanent' : reason;

    await recordSuppression({
      address,
      reason: effectiveReason,
      source: 'brevo',
      diagnostic: event.reason ?? event.event ?? null,
      reportedAt: event.ts ? new Date(event.ts * 1000) : new Date(),
      userId: null,
    });

    logger.info('Brevo feedback processed', { event: event.event, reason: effectiveReason });
    res.status(200).json({ applied: 1 });
  }),
);

export default router;
