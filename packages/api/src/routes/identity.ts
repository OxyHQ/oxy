/**
 * Identity Routes (self-sovereign identity layer — B5 signed records + B7 domains)
 *
 * Mounted at `/identity`:
 *  - `POST   /identity/records`                    (auth) publish a signed record
 *  - `GET    /identity/records/:userId/:type`      (public) latest record
 *  - `GET    /identity/records/:userId/:type/verify`(public) re-verify latest
 *  - `POST   /identity/domains`                    (auth) request a domain badge
 *  - `GET    /identity/domains`                    (auth) list verified + pending
 *  - `POST   /identity/domains/:domain/verify`     (auth) prove ownership
 *  - `DELETE /identity/domains/:domain`            (auth) remove a verified domain
 *
 * Domain verification proves ownership via a DNS-TXT record OR a `/.well-known`
 * file fetched through `safeFetch` (SSRF-safe — never a raw fetch of the
 * user-supplied domain).
 *
 * ## The cutover bug this port removes
 *
 * Five public read routes opened by running `userId` through the legacy 24-hex
 * id predicate in `utils/validation.ts` and throwing a 404 on a miss. That
 * predicate is `/^[0-9a-f]{24}$/i` and rejects the **uuid v7 every account
 * created after the Postgres cutover carries** (`@oxyhq/db`'s
 * `generatedId()`), so each answered 404 BEFORE ANY QUERY RAN for such an
 * account.
 *
 * `GET /identity/records/:userId/chain/head` is the severe one: `@oxyhq/core`
 * fetches it immediately before signing EVERY v2 record (`OxyServices.civic.ts`
 * `_signMyCivicRecordV2`, `OxyServices.nodes.ts` `registerMyNode`) to learn the
 * `seq`/`prev` it must sign over. A 404 there is not a degraded read — it aborts
 * the signature, so a post-cutover account could publish no civic record and
 * register no personal data node at all.
 *
 * All five guards are DELETED rather than widened. Each existed only to stop a
 * malformed string reaching Mongoose as a `CastError`; every id here is now a
 * `text` column compared against a bound parameter, so a malformed id is a value
 * that matches no row. The two record routes reach the IDENTICAL 404 by querying
 * (`getLatestRecord` returns null → `Record not found`); the three chain/log
 * routes now answer a malformed id exactly as they already answered an unknown
 * well-formed one — the empty chain — which is the consistency the guard broke,
 * since neither route ever checked that the account existed.
 *
 * ## Storage (Postgres)
 *
 * `User.verifiedDomains[]` is the child table `user_verified_domains` and
 * `DomainVerification` is `domain_verifications`, so "push onto the array" is an
 * INSERT and "filter the array" is a DELETE. Two consequences the Mongo version
 * could not have:
 *
 * - **Proving a domain is ONE transaction.** The badge write and the burn of the
 *   pending challenge commit together, so a crash between them can no longer
 *   leave a still-spendable token beside a granted badge.
 * - **A second live challenge for one (account, domain) is unrepresentable.**
 *   `domain_verifications_user_id_lower_domain_key` is a unique index on
 *   `(user_id, lower(domain))`, so the re-request path is a real upsert rather
 *   than a hope.
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import dns from 'dns';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../utils/error';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';
import { safeFetch } from '@oxyhq/core/server';
import {
  signedRecordEnvelopeSchema,
  domainVerificationRequestSchema,
  domainVerificationInstructionsSchema,
  type SignedRecordEnvelope,
  type ChainHeadResponse,
  type LogPageResponse,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { domainVerifications } from '../db/schema/domainVerifications';
import { users } from '../db/schema/users';
import { userVerifiedDomains, VERIFIED_DOMAIN_METHODS } from '../db/schema/userVerifiedDomains';
import userCache from '../utils/userCache';
import {
  verifyAndStoreRecord,
  verifyEnvelope,
  getLatestRecord,
} from '../services/signedRecord.service';
import { getHead, getPublicLogSince, resolveCursorSeq } from '../services/repoLog.service';
import { materializeNodeFromRecord } from '../services/nodeRegistry.service';

const router = Router();

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Per-authenticated-user rate-limit key (falls back to IP pre-auth). */
function userScopedKey(scope: string) {
  return (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `${scope}:${userId}` : `${scope}:ip:${hashedIpKey(req)}`;
  };
}

const domainRequestLimiter = rateLimit({
  prefix: 'rl:identity:domainreq:',
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many domain verification requests. Please try again later.',
  keyGenerator: userScopedKey('identity:domainreq'),
});

const domainVerifyLimiter = rateLimit({
  prefix: 'rl:identity:domainverify:',
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'Too many domain verification attempts. Please try again later.',
  keyGenerator: userScopedKey('identity:domainverify'),
});

/**
 * Public node-log read limiters (F5a). Keyed by IP — these endpoints are public
 * (a node, or anyone, re-reads the user's authentic signed chain to re-verify it
 * independently). Generous, since this is Oxy→node export of already-public
 * signed records. Both are pure Oxy-DB reads — they NEVER touch a node.
 */
const nodeLogLimiter = rateLimit({
  prefix: 'rl:nodes:log:',
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many log requests. Please slow down.',
});

const nodeHeadLimiter = rateLimit({
  prefix: 'rl:nodes:head:',
  windowMs: 60 * 1000,
  max: 240,
  message: 'Too many head requests. Please slow down.',
});

const DNS_PREFIX = '_oxy-identity.';
const TXT_PREFIX = 'oxy-domain-verification=';
const WELL_KNOWN_PATH = '/.well-known/oxy-domain';
const MAX_WELL_KNOWN_BYTES = 1024;

// RFC 1035 hostname: 1+ dot-separated labels of letters/digits/hyphens (no
// leading/trailing hyphen), at least one dot, total length bounded.
const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

function normalizeDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase();
  if (domain.length === 0 || domain.length > 253) return null;
  if (!DOMAIN_PATTERN.test(domain)) return null;
  return domain;
}

/**
 * `lower(<domain column>) = $1` — the spelling that matches the expression
 * unique indexes both domain tables are built on
 * (`domain_verifications_user_id_lower_domain_key`,
 * `user_verified_domains_user_id_lower_domain_key`).
 *
 * A plain `domain = $1` is correct-looking, case-sensitive, and would not use
 * either index. Mongoose's `lowercase: true` setter is what used to make the
 * naive comparison work and it has no Postgres counterpart;
 * {@link normalizeDomain} already lower-cased the bound parameter, so this makes
 * the STORED side agree too.
 */
function domainMatches(column: PgColumn, domain: string): SQL {
  return sql`lower(${column}) = ${domain}`;
}

/** Read up to `maxBytes` of a response stream as UTF-8, then stop. */
function readBoundedText(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total >= maxBytes) {
        chunks.push(chunk.subarray(0, chunk.length - (total - maxBytes)));
        (stream as { destroy?: () => void }).destroy?.();
        resolve(Buffer.concat(chunks).toString('utf8'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

/** True when a DNS-TXT proof for `token` is published at `_oxy-identity.<domain>`. */
async function checkDnsProof(domain: string, token: string): Promise<boolean> {
  try {
    const records = await dns.promises.resolveTxt(`${DNS_PREFIX}${domain}`);
    const expected = `${TXT_PREFIX}${token}`;
    return records.some((chunks) => chunks.join('').trim() === expected);
  } catch (error) {
    // ENOTFOUND/ENODATA simply mean "no TXT record yet" — not a server error.
    logger.debug('DNS-TXT domain proof lookup found no match', {
      component: 'identity',
      domain,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** True when a `/.well-known/oxy-domain` proof for `token` is served over HTTPS. */
async function checkWellKnownProof(domain: string, token: string): Promise<boolean> {
  try {
    const result = await safeFetch(`https://${domain}${WELL_KNOWN_PATH}`, {
      maxRedirects: 2,
      headersTimeoutMs: 5000,
    });
    if (result.status < 200 || result.status >= 300) {
      result.response.destroy();
      return false;
    }
    const body = await readBoundedText(result.response, MAX_WELL_KNOWN_BYTES);
    return body.trim() === token;
  } catch (error) {
    logger.debug('well-known domain proof fetch failed', {
      component: 'identity',
      domain,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Signed records (B5)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * POST /identity/records — publish a client-signed record about the caller.
 * The envelope's `subject` MUST be the caller's DID and its `publicKey` MUST be
 * a current verification method; verification + storage is atomic.
 */
router.post(
  '/records',
  authMiddleware,
  validate({ body: signedRecordEnvelopeSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const envelope = req.body as SignedRecordEnvelope;
    const result = await verifyAndStoreRecord(envelope, userId);
    if (!result.ok) {
      throw new BadRequestError(`Signed record rejected: ${result.reason}`);
    }

    // F5a: a verified `node` record registers the user's personal data node.
    // Project it into the operational cache (upsert + fire a background liveness
    // probe). Best-effort and non-throwing — the signed record is already stored
    // on the chain; the request never awaits the node itself.
    if (envelope.type === 'node') {
      await materializeNodeFromRecord(userId, envelope.record);
    }

    res.status(201).json({
      envelope: result.record.envelope,
      verified: result.record.verified,
    });
  }),
);

/**
 * GET /identity/records/:userId/chain/head — the subject's hash-chain head
 * (public, cacheable, CORS-open). A client fetches this before signing the next
 * v2 record so it knows the `prev` (head `recordId`) and `seq` (`head.seq + 1`)
 * to sign over. Response shape (F0.2 contract — F1/client agents match this):
 *  - with a chain: `{ headRecordId: string, seq: number, recordCount: number }`
 *  - no chain yet: `{ headRecordId: null, seq: -1, recordCount: 0 }`
 *
 * Registered BEFORE `/:type` so the literal `chain/head` path is unambiguous.
 *
 * There is deliberately NO id-shape precheck: the one that used to stand here
 * 404'd every post-cutover account, which aborts client-side signing of every v2
 * record (see the module header). An unknown account and a malformed id both
 * resolve to the empty chain, which is what this route has always answered for
 * an account that exists but has published nothing.
 */
router.get(
  '/records/:userId/chain/head',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const head = await getHead(userId);
    const payload: ChainHeadResponse = head
      ? { headRecordId: head.headRecordId, seq: head.seq, recordCount: head.recordCount }
      : { headRecordId: null, seq: -1, recordCount: 0 };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=5');
    res.json(payload);
  }),
);

/**
 * GET /identity/log/:userId?since=<seq|recordId>&limit= — the ordered slice of a
 * subject's public-safe verified signed-record chain (identity/profile/node
 * records only; the FULL envelopes, so a node or any verifier re-checks them
 * independently). This is the Oxy→node export of the public bootstrap chain.
 * Public, CORS-open, short-cached. A pure Oxy-DB read — it
 * touches ONLY Oxy's own copy of the chain, never a node. `since` is a chain
 * `seq` (exclusive) or the last-ingested `recordId`; absent → from genesis.
 */
router.get(
  '/log/:userId',
  nodeLogLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;

    let sinceSeq = -1;
    const sinceRaw = typeof req.query.since === 'string' ? req.query.since.trim() : '';
    if (sinceRaw.length > 0) {
      if (/^\d+$/.test(sinceRaw)) {
        sinceSeq = Number.parseInt(sinceRaw, 10);
      } else {
        const resolved = await resolveCursorSeq(userId, sinceRaw);
        if (resolved === null) {
          throw new BadRequestError('Unknown `since` cursor');
        }
        sinceSeq = resolved;
      }
    }

    const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : Number.NaN;
    const records = await getPublicLogSince(userId, sinceSeq, Number.isFinite(limitRaw) ? limitRaw : undefined);

    const page: LogPageResponse = { records, count: records.length };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=5');
    res.json(page);
  }),
);

/**
 * GET /identity/head/:userId — the subject's chain head from {@link RepoHead}
 * (O(1)): `{ seq, headRecordId, recordCount }`, or the empty form when the user
 * has no chain yet. Node-facing alias of the chain head; public, CORS-open,
 * short-cached, never touches a node.
 */
router.get(
  '/head/:userId',
  nodeHeadLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const head = await getHead(userId);
    const payload: ChainHeadResponse = head
      ? { headRecordId: head.headRecordId, seq: head.seq, recordCount: head.recordCount }
      : { headRecordId: null, seq: -1, recordCount: 0 };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=5');
    res.json(payload);
  }),
);

/** GET /identity/records/:userId/:type — the latest published record (public). */
router.get(
  '/records/:userId/:type',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId, type } = req.params;
    if (type !== 'identity' && type !== 'profile') {
      throw new BadRequestError('type must be "identity" or "profile"');
    }

    const record = await getLatestRecord(userId, type);
    if (!record) {
      throw new NotFoundError('Record not found');
    }

    res.json({ record: record.envelope });
  }),
);

/** GET /identity/records/:userId/:type/verify — re-verify the latest record (public). */
router.get(
  '/records/:userId/:type/verify',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId, type } = req.params;
    if (type !== 'identity' && type !== 'profile') {
      throw new BadRequestError('type must be "identity" or "profile"');
    }

    const record = await getLatestRecord(userId, type);
    if (!record) {
      throw new NotFoundError('Record not found');
    }

    // The subject must still exist for a re-verification to mean anything: the
    // verdict is computed against the account's CURRENT verification methods, so
    // a record whose subject is gone is reported as absent rather than as
    // unverifiable. Only `id` is read — this is an existence check, and a
    // whole-row select would pull the account's protected columns into a public
    // route for nothing (`db/schema/protectedColumns.ts`).
    const [subject] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!subject) {
      throw new NotFoundError('Record not found');
    }

    const verification = await verifyEnvelope(record.envelope, userId);

    res.json({
      verified: verification.ok,
      ...(verification.ok ? {} : { reason: verification.reason }),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/*  Domain verification (B7)                                                  */
/* -------------------------------------------------------------------------- */

/** POST /identity/domains — request a verification token + instructions. */
router.post(
  '/domains',
  authMiddleware,
  domainRequestLimiter,
  validate({ body: domainVerificationRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const domain = normalizeDomain(req.body.domain);
    if (!domain) {
      throw new BadRequestError('Invalid domain');
    }

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Upsert: one in-flight challenge per (account, domain), so re-requesting
    // REPLACES the token rather than issuing a second valid one.
    //
    // `onConflictDoNothing()` carries no target because the index it must infer
    // is an EXPRESSION index (`(user_id, lower(domain))`) and drizzle's
    // `onConflictDoUpdate` target accepts columns only — it calls `escapeName`
    // on each entry, so an `sql` expression throws before a query is built. The
    // untargeted form needs no inference and the table's only other unique index
    // is the primary key, which a freshly generated uuid v7 cannot collide with.
    //
    // The follow-up UPDATE cannot miss: `DO NOTHING` waits on a concurrent
    // inserter and applies only once that transaction COMMITS the conflicting
    // row (had it rolled back, this insert would have succeeded instead), so
    // reaching here means the row is committed and visible.
    const inserted = await getDb()
      .insert(domainVerifications)
      .values({ userId, domain, token, expiresAt })
      .onConflictDoNothing()
      .returning({ id: domainVerifications.id });
    if (inserted.length === 0) {
      await getDb()
        .update(domainVerifications)
        .set({ token, expiresAt })
        .where(
          and(
            eq(domainVerifications.userId, userId),
            domainMatches(domainVerifications.domain, domain),
          ),
        );
    }

    const instructions = domainVerificationInstructionsSchema.parse({
      domain,
      token,
      dns: { name: `${DNS_PREFIX}${domain}`, value: `${TXT_PREFIX}${token}` },
      wellKnown: { url: `https://${domain}${WELL_KNOWN_PATH}`, body: token },
    });

    res.status(201).json(instructions);
  }),
);

/** GET /identity/domains — the account's verified-domain badges. */
router.get(
  '/domains',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    // Ordered so the badge list is stable between calls: `created_at` is the
    // meaningful form of the Mongo array's insertion order (re-verifying a
    // domain updates `verified_at` in place, exactly as the array entry was
    // updated in place), with the time-ordered uuid v7 `id` as a total tiebreak.
    const domains = await getDb()
      .select({
        domain: userVerifiedDomains.domain,
        verifiedAt: userVerifiedDomains.verifiedAt,
        method: userVerifiedDomains.method,
      })
      .from(userVerifiedDomains)
      .where(eq(userVerifiedDomains.userId, userId))
      .orderBy(userVerifiedDomains.createdAt, userVerifiedDomains.id);

    res.json({ domains });
  }),
);

/** POST /identity/domains/:domain/verify — prove ownership via DNS or well-known. */
router.post(
  '/domains/:domain/verify',
  authMiddleware,
  domainVerifyLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const domain = normalizeDomain(req.params.domain);
    if (!domain) {
      throw new BadRequestError('Invalid domain');
    }

    const [pending] = await getDb()
      .select({ id: domainVerifications.id, token: domainVerifications.token, expiresAt: domainVerifications.expiresAt })
      .from(domainVerifications)
      .where(
        and(
          eq(domainVerifications.userId, userId),
          domainMatches(domainVerifications.domain, domain),
        ),
      )
      .limit(1);
    // The expiry comparison is ported VERBATIM. `db/expiry.ts` sweeps this table
    // on an interval, so the row can outlive its own deadline by up to one
    // sweep; dropping the check because "the sweep handles it" would turn a
    // bounded lag into a live credential (`schema/CONVENTIONS.md`, "Expiry",
    // class (A)).
    if (!pending || pending.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestError('No active verification challenge for this domain. Request one first.');
    }

    let method: (typeof VERIFIED_DOMAIN_METHODS)[number] | null = null;
    if (await checkDnsProof(domain, pending.token)) {
      method = 'dns-txt';
    } else if (await checkWellKnownProof(domain, pending.token)) {
      method = 'well-known';
    }

    if (!method) {
      throw new BadRequestError('Domain ownership could not be verified. Publish the DNS-TXT record or well-known file and try again.');
    }

    const verifiedAt = new Date();
    // Granting the badge and burning the challenge commit together. Mongo could
    // only do them in sequence, so a failure between the two left a proven
    // domain beside a token that was still spendable.
    //
    // No account-existence check precedes this: `domain_verifications.user_id`
    // references `users` with `ON DELETE CASCADE`, so finding a pending
    // challenge for this account IS proof the account exists — the branch that
    // used to answer `User not found` here is unreachable by construction.
    await getDb().transaction(async (tx) => {
      const inserted = await tx
        .insert(userVerifiedDomains)
        .values({ userId, domain, verifiedAt, method })
        .onConflictDoNothing()
        .returning({ id: userVerifiedDomains.id });
      if (inserted.length === 0) {
        // Re-verifying an already-proven domain refreshes it in place, exactly
        // as the Mongo array entry was updated in place — never a second badge.
        // Untargeted `DO NOTHING` for the same reason as the challenge upsert:
        // the unique index here is on `(user_id, lower(domain))`, an expression
        // drizzle's conflict target cannot express.
        await tx
          .update(userVerifiedDomains)
          .set({ verifiedAt, method })
          .where(
            and(
              eq(userVerifiedDomains.userId, userId),
              domainMatches(userVerifiedDomains.domain, domain),
            ),
          );
      }
      await tx.delete(domainVerifications).where(eq(domainVerifications.id, pending.id));
    });
    userCache.invalidate(userId);

    res.json({ verified: true, domain: { domain, verifiedAt, method } });
  }),
);

/** DELETE /identity/domains/:domain — remove a verified-domain badge. */
router.delete(
  '/domains/:domain',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const domain = normalizeDomain(req.params.domain);
    if (!domain) {
      throw new BadRequestError('Invalid domain');
    }

    // The DELETE is the existence check: it removes the badge and reports
    // whether there was one, so "no such badge" needs no separate read. An
    // account with no row and a domain that was never proven are the same "there
    // is nothing to remove" outcome — and the row could not exist without the
    // account, which the foreign key enforces.
    const removed = await getDb()
      .delete(userVerifiedDomains)
      .where(
        and(
          eq(userVerifiedDomains.userId, userId),
          domainMatches(userVerifiedDomains.domain, domain),
        ),
      )
      .returning({ id: userVerifiedDomains.id });
    if (removed.length === 0) {
      throw new NotFoundError('Domain is not verified for this account');
    }

    userCache.invalidate(userId);
    // Drop any challenge still outstanding for the domain, so re-adding it later
    // starts from a fresh token rather than one issued before the badge was
    // revoked.
    await getDb()
      .delete(domainVerifications)
      .where(
        and(
          eq(domainVerifications.userId, userId),
          domainMatches(domainVerifications.domain, domain),
        ),
      );

    res.json({ success: true });
  }),
);

export default router;
