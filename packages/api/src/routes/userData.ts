/**
 * User App-Data Routes (`/users/me/app-data/...`)
 *
 * Generic per-user key/value store keyed by `(namespace, key)`. Authenticated
 * users may read, write, list, and delete entries scoped to their own
 * account; the routes do not allow access to anyone else's data.
 *
 * First consumer: Oxy Academy progress tracker on oxy.so. The shape is kept
 * generic so any Oxy surface can persist small bits of cross-device app
 * state without growing a bespoke schema.
 *
 * Limits:
 *   - 64 KB serialized JSON per value (enforced by the schema).
 *   - 100 writes/minute/user across PUT and DELETE (rate-limit middleware
 *     keyed on the authenticated user ID).
 *   - At most 128 keys per namespace and 1024 keys per user.
 *   - Namespace and key must match `[a-z0-9_-]{1,64}`.
 *
 * ## Postgres port notes
 *
 * `value` is `jsonb` and genuinely shape-less — the one honest `jsonb` in the
 * batch (`schema/userAppData.ts`). Two consequences the routes depend on:
 *
 *   - **`{}` is a VALUE, not an absence.** Mongoose set `minimize: false` here
 *     precisely so an empty object survived the round trip; `jsonb` preserves it
 *     natively, and the response contract (`{ value }`) must never collapse it
 *     to `null`.
 *   - **A stored JSON `null` and an absent row are both reported as `null`.**
 *     That is the pre-existing contract — this endpoint does not 404 on a
 *     missing entry — and it is unchanged.
 *
 * Every read and write is SCOPED to the authenticated account in the same
 * `WHERE`, so there is no shape of request that reaches another user's row.
 */

import { Router, type Response } from 'express';
import { and, count, eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError, ConflictError, UnauthorizedError } from '../utils/error';
import { logger } from '../utils/logger';
import { getDb } from '../config/postgres';
import { userAppData } from '../db/schema/userAppData';
import {
  appDataKeyParamsSchema,
  appDataNamespaceParamsSchema,
  appDataValueBodySchema,
  APP_DATA_MAX_NAMESPACE_KEYS,
  APP_DATA_MAX_USER_KEYS,
} from '../schemas/userData.schemas';

const router = Router();

async function enforceAppDataKeyQuotas(userId: string, namespace: string, key: string): Promise<void> {
  const db = getDb();
  const [existing] = await db
    .select({ id: userAppData.id })
    .from(userAppData)
    .where(
      and(
        eq(userAppData.userId, userId),
        eq(userAppData.namespace, namespace),
        eq(userAppData.key, key),
      ),
    )
    .limit(1);
  if (existing) {
    return;
  }

  const [namespaceRows, userRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(userAppData)
      .where(and(eq(userAppData.userId, userId), eq(userAppData.namespace, namespace))),
    db.select({ n: count() }).from(userAppData).where(eq(userAppData.userId, userId)),
  ]);
  const namespaceKeyCount = namespaceRows[0]?.n ?? 0;
  const userKeyCount = userRows[0]?.n ?? 0;

  if (namespaceKeyCount >= APP_DATA_MAX_NAMESPACE_KEYS) {
    throw new ConflictError('App-data namespace key quota exceeded', {
      limit: APP_DATA_MAX_NAMESPACE_KEYS,
      namespace,
    });
  }

  if (userKeyCount >= APP_DATA_MAX_USER_KEYS) {
    throw new ConflictError('App-data user key quota exceeded', {
      limit: APP_DATA_MAX_USER_KEYS,
    });
  }
}

/**
 * Per-user write rate limiter: 100 writes (PUT + DELETE) per minute.
 *
 * Keyed on the user ID extracted from the bearer token so it follows the
 * account across networks and so NAT'd clients don't share buckets. Falls
 * back to IP when the token can't be decoded (the request will then fail in
 * `authMiddleware` anyway, but the limiter still gets a stable key).
 */
const writeLimiter = rateLimit({
  prefix: 'rl:userdata:write:',
  windowMs: 60 * 1000,
  max: 100,
  message: 'Too many app-data writes. Please slow down and try again shortly.',
  keyGenerator: (req) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ') && process.env.ACCESS_TOKEN_SECRET) {
      try {
        const decoded = jwt.decode(authHeader.slice('Bearer '.length));
        if (decoded && typeof decoded === 'object') {
          const claims = decoded as { userId?: string; sub?: string };
          const userId = claims.userId || claims.sub;
          if (typeof userId === 'string' && userId.length > 0) {
            return `userAppData:write:${userId}`;
          }
        }
      } catch (error) {
        logger.debug('Could not decode token for app-data rate-limit key', {
          component: 'userAppData',
          method: 'writeLimiter.keyGenerator',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return `userAppData:write:ip:${hashedIpKey(req)}`;
  },
});

/**
 * @openapi
 * /users/me/app-data/{namespace}/{key}:
 *   get:
 *     tags: [UserAppData]
 *     summary: Read a single per-user JSON value
 *     description: >
 *       Returns the value stored under `(namespace, key)` for the authenticated
 *       user. The response body is always `{ value }`. If no value has ever
 *       been stored, `value` is `null` (the endpoint does not 404 on missing
 *       entries — a missing entry is semantically a `null` value).
 *     parameters:
 *       - in: path
 *         name: namespace
 *         required: true
 *         schema: { type: string, pattern: '^[a-z0-9_-]{1,64}$' }
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string, pattern: '^[a-z0-9_-]{1,64}$' }
 *     responses:
 *       200:
 *         description: Current value (or null when not stored).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 value:
 *                   description: Arbitrary JSON value previously stored, or null.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.get(
  '/:namespace/:key',
  authMiddleware,
  validate({ params: appDataKeyParamsSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user?.id) {
      throw new UnauthorizedError('Authentication required');
    }
    const { namespace, key } = req.params;
    const [row] = await getDb()
      .select({ value: userAppData.value })
      .from(userAppData)
      .where(
        and(
          eq(userAppData.userId, req.user.id),
          eq(userAppData.namespace, namespace),
          eq(userAppData.key, key),
        ),
      )
      .limit(1);

    return res.json({ value: row ? row.value ?? null : null });
  }),
);

/**
 * @openapi
 * /users/me/app-data/{namespace}/{key}:
 *   put:
 *     tags: [UserAppData]
 *     summary: Upsert a single per-user JSON value
 *     description: >
 *       Stores (or replaces) the value under `(namespace, key)` for the
 *       authenticated user. Body must be `{ value: <any JSON-serializable
 *       value> }`. Serialized JSON is capped at 64 KB.
 *     parameters:
 *       - in: path
 *         name: namespace
 *         required: true
 *         schema: { type: string, pattern: '^[a-z0-9_-]{1,64}$' }
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string, pattern: '^[a-z0-9_-]{1,64}$' }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [value]
 *             properties:
 *               value:
 *                 description: Arbitrary JSON value to persist.
 *     responses:
 *       200:
 *         description: The stored value, echoed back.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 value: { description: The value that is now stored. }
 *       400:
 *         description: Validation failed (bad namespace/key, oversized value).
 *       401:
 *         description: Missing or invalid bearer token.
 *       429:
 *         description: Per-user write rate limit exceeded.
 */
router.put(
  '/:namespace/:key',
  authMiddleware,
  writeLimiter,
  validate({
    params: appDataKeyParamsSchema,
    body: appDataValueBodySchema,
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user?.id) {
      throw new UnauthorizedError('Authentication required');
    }
    const { namespace, key } = req.params;
    const { value } = req.body as { value: unknown };

    await enforceAppDataKeyQuotas(req.user.id, namespace, key);

    // `$setOnInsert: { createdAt }` needs no counterpart: `created_at` is absent
    // from the conflict arm, so an existing row keeps its original. `updated_at`
    // is bumped by the column's own `$onUpdate`, the port of what Mongoose's
    // `timestamps` did.
    const [row] = await getDb()
      .insert(userAppData)
      .values({ userId: req.user.id, namespace, key, value })
      .onConflictDoUpdate({
        target: [userAppData.userId, userAppData.namespace, userAppData.key],
        set: { value },
      })
      .returning({ value: userAppData.value });

    return res.json({ value: row ? row.value ?? null : value });
  }),
);

/**
 * @openapi
 * /users/me/app-data/{namespace}/{key}:
 *   delete:
 *     tags: [UserAppData]
 *     summary: Delete a single per-user JSON value
 *     description: >
 *       Removes the value under `(namespace, key)` for the authenticated user.
 *       Idempotent — succeeds with 204 whether or not the entry existed.
 *     parameters:
 *       - in: path
 *         name: namespace
 *         required: true
 *         schema: { type: string, pattern: '^[a-z0-9_-]{1,64}$' }
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string, pattern: '^[a-z0-9_-]{1,64}$' }
 *     responses:
 *       204:
 *         description: Deleted (or was already absent).
 *       401:
 *         description: Missing or invalid bearer token.
 *       429:
 *         description: Per-user write rate limit exceeded.
 */
router.delete(
  '/:namespace/:key',
  authMiddleware,
  writeLimiter,
  validate({ params: appDataKeyParamsSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user?.id) {
      throw new UnauthorizedError('Authentication required');
    }
    const { namespace, key } = req.params;
    await getDb()
      .delete(userAppData)
      .where(
        and(
          eq(userAppData.userId, req.user.id),
          eq(userAppData.namespace, namespace),
          eq(userAppData.key, key),
        ),
      );
    return res.status(204).send();
  }),
);

/**
 * @openapi
 * /users/me/app-data/{namespace}:
 *   get:
 *     tags: [UserAppData]
 *     summary: List every value in a namespace for the current user
 *     description: >
 *       Returns `{ entries }` where `entries` is a `key -> value` map of
 *       everything stored under `namespace` for the authenticated user. The
 *       response is bounded by the 128-key namespace quota and by the 64 KB
 *       cap per individual value. If an older namespace exceeds the current
 *       quota, the endpoint refuses to materialize it in one response.
 *     parameters:
 *       - in: path
 *         name: namespace
 *         required: true
 *         schema: { type: string, pattern: '^[a-z0-9_-]{1,64}$' }
 *     responses:
 *       200:
 *         description: Map of every key in the namespace to its value.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 entries:
 *                   type: object
 *                   additionalProperties:
 *                     description: Stored JSON value.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.get(
  '/:namespace',
  authMiddleware,
  validate({ params: appDataNamespaceParamsSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user?.id) {
      throw new UnauthorizedError('Authentication required');
    }
    const { namespace } = req.params;
    // Ordered by key: a `LIMIT` without an `ORDER BY` leaves WHICH rows come
    // back unspecified in Postgres, so the over-quota probe below would be
    // reading an arbitrary subset. Mongo's natural order was equally arbitrary
    // but the map response makes row order invisible either way.
    const rows = await getDb()
      .select({ key: userAppData.key, value: userAppData.value })
      .from(userAppData)
      .where(and(eq(userAppData.userId, req.user.id), eq(userAppData.namespace, namespace)))
      .orderBy(userAppData.key)
      .limit(APP_DATA_MAX_NAMESPACE_KEYS + 1);

    if (rows.length > APP_DATA_MAX_NAMESPACE_KEYS) {
      throw new ApiError(
        413,
        'App-data namespace exceeds the maximum list response size',
        'PAYLOAD_TOO_LARGE',
        { limit: APP_DATA_MAX_NAMESPACE_KEYS, namespace },
      );
    }

    const entries: Record<string, unknown> = {};
    for (const row of rows) {
      entries[row.key] = row.value ?? null;
    }
    return res.json({ entries });
  }),
);

export default router;
