/**
 * Contact Discovery Routes
 *
 * Privacy-preserving discovery of which of a user's address-book contacts
 * already have Oxy accounts. Clients hash emails/phones locally with SHA-256
 * (see `utils/contactHash.ts` for the canonical algorithm) and upload only
 * those digests. The server intersects them against the partial indexes on
 * `users.hashed_email` / `users.hashed_phone` and returns matched user IDs only
 * for users who explicitly opted in to contact discovery for that identifier
 * type.
 *
 * Privacy invariants:
 *   - Raw email / phone never traverses this route.
 *   - The response contains no PII — only opted-in Oxy user IDs and the
 *     hash the caller supplied (so the client can map matches back to the
 *     local contact that produced them).
 *   - Stored contact hashes are never queryable for users who have not
 *     explicitly enabled `privacySettings.discoverableByEmail` or
 *     `privacySettings.discoverableByPhone`.
 *   - No write to the database. Discovery is stateless.
 *
 * Abuse controls:
 *   - Authenticated user only (no service tokens — this is owner-only data).
 *   - Per-user 5 req/min via `keyGenerator` keyed on the resolved user ID.
 *   - Per-request payload capped at 200 hashes per channel (~400 total).
 *
 * ## `hashed_email` / `hashed_phone` are PROTECTED columns, read on purpose
 *
 * Both are in `protectedColumns.ts`, so no ordinary read returns them. This
 * route names them explicitly in its `select`, which is exactly the sanctioned
 * opt-in: the matched hash is the only thing that lets the CLIENT map a match
 * back to the address-book entry that produced it, and it is a value the caller
 * already supplied — the response tells them nothing they did not send.
 */

import { Router, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { ForbiddenError, UnauthorizedError } from '../utils/error';
import { logger } from '../utils/logger';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { discoverContactsSchema } from '../schemas/contacts.schemas';

const router = Router();

/**
 * Rate limiter: 5 requests per minute per authenticated user.
 *
 * Keyed on the user ID extracted from the bearer token (not the IP) so that
 * the limit follows the account across networks and so that NATed clients
 * don't share buckets.
 */
const discoverLimiter = rateLimit({
  prefix: 'rl:contacts:discover:',
  windowMs: 60 * 1000,
  max: 5,
  message:
    'Too many contact discovery requests. Please wait a minute before trying again.',
  keyGenerator: (req) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ') && process.env.ACCESS_TOKEN_SECRET) {
      try {
        const decoded = jwt.decode(authHeader.slice('Bearer '.length));
        if (decoded && typeof decoded === 'object') {
          const claims = decoded as { userId?: string; sub?: string };
          const userId = claims.userId || claims.sub;
          if (typeof userId === 'string' && userId.length > 0) {
            return `contacts:discover:${userId}`;
          }
        }
      } catch (error) {
        logger.debug('Could not decode token for rate-limit key', {
          component: 'contacts',
          method: 'discoverLimiter.keyGenerator',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return `contacts:discover:ip:${hashedIpKey(req)}`;
  },
});

/**
 * Reject tokens that were minted via `/auth/service-token` — discovery
 * operates on the owner's address book, so service-to-service callers have
 * no legitimate need for it (they can't represent an end-user's contacts).
 */
function rejectServiceTokens(req: AuthRequest, _res: Response, next: () => void): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ') && process.env.ACCESS_TOKEN_SECRET) {
    const token = authHeader.slice('Bearer '.length);
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded === 'object') {
      const tokenType = (decoded as { type?: string }).type;
      if (tokenType === 'service') {
        throw new ForbiddenError(
          'Service tokens cannot perform contact discovery — use a user session token.',
        );
      }
    }
  }
  next();
}

interface DiscoverMatch {
  userId: string;
  hashedIdentifier: string;
  matchType: 'email' | 'phone';
}

/** A matched account and the contact hash that matched it. */
interface HashMatchRow {
  id: string;
  hash: string | null;
}

/**
 * Matched rows → wire matches.
 *
 * The `hash === null` arm narrows the column's type rather than discarding a
 * possible row: `hashed_email`/`hashed_phone` are GENERATED and therefore
 * nullable in the schema, but `col in ($1, …)` never matches a NULL, so a row
 * that reached here always carries the hash it was selected by.
 */
function toMatches(
  rows: readonly HashMatchRow[],
  matchType: DiscoverMatch['matchType'],
): DiscoverMatch[] {
  return rows.flatMap((row) =>
    row.hash === null ? [] : [{ userId: row.id, hashedIdentifier: row.hash, matchType }],
  );
}

/**
 * @openapi
 * /contacts/discover:
 *   post:
 *     tags:
 *       - Contacts
 *     summary: Discover which contacts are on Oxy
 *     description: >
 *       Privacy-preserving contact-book matching. Clients SHA-256 hash each
 *       email and phone number locally (lowercased; phone numbers normalised
 *       to E.164 — see `utils/contactHash.ts` in `@oxyhq/core`) and upload
 *       only the resulting 64-character hex digests. The server intersects
 *       them against the indexed `users.hashed_email` / `users.hashed_phone`
 *       columns and returns matched Oxy user IDs only when the matched user
 *       has opted in to contact discovery for that identifier type.
 *
 *       Privacy invariants:
 *         - Raw email / phone never traverses this endpoint.
 *         - The response contains no PII — only Oxy user IDs and the hash the
 *           caller supplied (so the client can map matches back to the local
 *           contact that produced them).
 *         - The endpoint never writes to the database. Discovery is stateless.
 *
 *       Rate limits: 5 requests per minute per authenticated user; up to 200
 *       hashed identifiers per channel (~400 total) per request. Service
 *       tokens are explicitly rejected with 403.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hashedEmails:
 *                 type: array
 *                 maxItems: 200
 *                 items:
 *                   type: string
 *                   pattern: '^[a-f0-9]{64}$'
 *                   description: SHA-256 hex of `email.toLowerCase().trim()`.
 *               hashedPhones:
 *                 type: array
 *                 maxItems: 200
 *                 items:
 *                   type: string
 *                   pattern: '^[a-f0-9]{64}$'
 *                   description: SHA-256 hex of the E.164-normalised phone number.
 *           examples:
 *             addressBook:
 *               summary: Mixed email + phone request
 *               value:
 *                 hashedEmails:
 *                   - 7c211433f02071597741e6ff5a8ea34789abbf43b9c1abcdef0123456789abcd
 *                 hashedPhones:
 *                   - 9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba
 *     responses:
 *       200:
 *         description: Discovery completed. Empty `matches` means no overlap.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 matches:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required:
 *                       - userId
 *                       - hashedIdentifier
 *                       - matchType
 *                     properties:
 *                       userId:
 *                         type: string
 *                         example: 64f7c2a1b8e9d3f4a1c2b3d4
 *                       hashedIdentifier:
 *                         type: string
 *                         example: 7c211433f02071597741e6ff5a8ea34789abbf43b9c1abcdef0123456789abcd
 *                       matchType:
 *                         type: string
 *                         enum: [email, phone]
 *             examples:
 *               oneMatch:
 *                 value:
 *                   matches:
 *                     - userId: 64f7c2a1b8e9d3f4a1c2b3d4
 *                       hashedIdentifier: 7c211433f02071597741e6ff5a8ea34789abbf43b9c1abcdef0123456789abcd
 *                       matchType: email
 *       400:
 *         description: Validation failed (empty payload, malformed hash, oversized batch).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing or invalid bearer token.
 *       403:
 *         description: Service token used — must use a user session token.
 *       429:
 *         description: Rate limit exceeded (5 requests / minute / user).
 */
router.post(
  '/discover',
  authMiddleware,
  rejectServiceTokens,
  discoverLimiter,
  validate({ body: discoverContactsSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user?.id) {
      throw new UnauthorizedError('Authentication required');
    }

    const { hashedEmails, hashedPhones } = req.body as {
      hashedEmails: string[];
      hashedPhones: string[];
    };

    // De-dupe within the request so a contact with the same email listed twice
    // doesn't cost us two index lookups.
    const uniqueEmailHashes = Array.from(new Set(hashedEmails));
    const uniquePhoneHashes = Array.from(new Set(hashedPhones));

    // Build the discovery query. We do two short queries (one per index) and
    // merge results so that a single user matched on both email and phone
    // shows up as two distinct entries — the client may want to surface that
    // either signal contributed to the match.
    //
    // Mongo's `type: { $in: ['local', null] }` becomes a plain equality: the
    // `null` arm existed only for documents predating the field, and
    // `users.type` is `NOT NULL DEFAULT 'local'`, so the legacy branch does not
    // travel.
    const db = getDb();
    const callerId = req.user.id;
    const [emailMatches, phoneMatches] = await Promise.all([
      uniqueEmailHashes.length > 0
        ? db
            .select({ id: users.id, hash: users.hashedEmail })
            .from(users)
            .where(
              and(
                inArray(users.hashedEmail, uniqueEmailHashes),
                // Don't return the caller's own account — they already know
                // they're on Oxy.
                ne(users.id, callerId),
                ne(users.accountStatus, 'archived'),
                ne(users.reputationTier, 'restricted'),
                // Federated/agent/automated accounts are not meant to surface
                // in a personal contact-sync flow.
                eq(users.type, 'local'),
                // Contact discovery is opt-in. Without this gate, deterministic
                // email/phone hashes can be used as an account-enumeration oracle.
                eq(users.privacyDiscoverableByEmail, true),
              ),
            )
        : Promise.resolve([] as HashMatchRow[]),
      uniquePhoneHashes.length > 0
        ? db
            .select({ id: users.id, hash: users.hashedPhone })
            .from(users)
            .where(
              and(
                inArray(users.hashedPhone, uniquePhoneHashes),
                ne(users.id, callerId),
                ne(users.accountStatus, 'archived'),
                ne(users.reputationTier, 'restricted'),
                eq(users.type, 'local'),
                // Contact discovery is opt-in. Without this gate, deterministic
                // phone hashes can be used as an account-enumeration oracle.
                eq(users.privacyDiscoverableByPhone, true),
              ),
            )
        : Promise.resolve([] as HashMatchRow[]),
    ]);

    const matches: DiscoverMatch[] = [
      ...toMatches(emailMatches, 'email'),
      ...toMatches(phoneMatches, 'phone'),
    ];

    logger.info('Contact discovery completed', {
      component: 'contacts',
      method: 'discover',
      userId: req.user.id,
      emailHashesIn: uniqueEmailHashes.length,
      phoneHashesIn: uniquePhoneHashes.length,
      matchCount: matches.length,
    });

    res.json({ matches });
  }),
);

export default router;
