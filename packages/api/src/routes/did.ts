/**
 * DID Document Routes (self-sovereign identity layer — B2)
 *
 * Serves the W3C `did:web` documents that make an Oxy account resolvable by any
 * standard DID resolver:
 *  - `GET /.well-known/did.json` — the Oxy organisation DID (`did:web:<domain>`)
 *  - `GET /u/:userId/did.json`   — a user DID (`did:web:<domain>:u:<userId>`)
 *
 * Public, cacheable, CORS-open (`Access-Control-Allow-Origin: *`), no auth — a
 * DID document is public infrastructure. Mounted at the API root in
 * `server.ts` beside the WebFinger/ActivityPub handlers, OUTSIDE the `/users`
 * rate-limit group.
 *
 * Resolution note: `did:web:oxy.so` resolves to `https://oxy.so/u/<id>/did.json`,
 * so the apex proxy must forward the user-DID and well-known-DID paths to this
 * API exactly as it already forwards the well-known and ActivityPub prefixes.
 *
 * ## No id-shape guard
 *
 * Ids are either legacy 24-hex ids or **uuid v7** (`@oxy.so/db`'s
 * `generatedId()`). A 24-hex check on `userId` would 404 every uuid account's
 * DID BEFORE ANY QUERY RAN — the account would not be resolvable by any DID
 * resolver, remote fediverse instance, or Oxy's own credential verifier, and
 * the response would be indistinguishable from "no such account".
 *
 * `users.id` is a `text` column compared against a bound parameter, so a
 * malformed id is simply a value that matches no row — reaching the 404 body
 * (`{error:'NOT_FOUND', message:'DID not found'}`) by querying instead of by
 * guessing at the string's shape.
 *
 * ## Storage (Postgres)
 *
 * `authMethods[]` and `verifiedDomains[]` are child tables, so the read is three
 * explicit queries.
 * Only the columns the DID document is derived from are selected — the rest of
 * the `users` row, protected columns included, never enters this path.
 *
 * Both child reads are ORDERED. The DID document is a public contract whose
 * `verificationMethod[]` fragments are positional (`#key-1`, `#key-2`, …) and
 * whose `alsoKnownAs[]` is consumed verbatim by remote resolvers, so heap order
 * — which is what an unordered Postgres read returns — would let the SAME
 * account serve two different documents. `linked_at` / `created_at` give
 * insertion order, with the (uuid v7, time-ordered) `id` breaking a
 * same-instant tie so the order is total.
 */

import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { users } from '../db/schema/users';
import { userVerifiedDomains } from '../db/schema/userVerifiedDomains';
import { buildDidDocument, buildOxyDidDocument } from '../services/did.service';
import { getUserNode } from '../services/nodeRegistry.service';
import { logger } from '../utils/logger';

const router = Router();

/** Headers shared by every DID document response. */
function setDidHeaders(res: Response): void {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
}

// Oxy organisation DID document.
router.get('/.well-known/did.json', (_req: Request, res: Response) => {
  setDidHeaders(res);
  return res.json(buildOxyDidDocument());
});

// Per-user DID document.
router.get('/u/:userId/did.json', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const db = getDb();

    const [account] = await db
      .select({
        id: users.id,
        publicKey: users.publicKey,
        username: users.username,
        type: users.type,
        federationDomain: users.federationDomain,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!account) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'DID not found' });
    }

    // F5a: announce the user's personal data node when one is ACTIVE. This reads
    // Oxy's own UserNode cache (an Oxy-DB read) — it does NOT reach the node, so
    // the read-path invariant holds even if the node is down.
    const [authMethods, verifiedDomains, node] = await Promise.all([
      db
        .select({ type: userAuthMethods.type, methodPublicKey: userAuthMethods.methodPublicKey })
        .from(userAuthMethods)
        .where(eq(userAuthMethods.userId, userId))
        .orderBy(userAuthMethods.linkedAt, userAuthMethods.id),
      db
        .select({ domain: userVerifiedDomains.domain })
        .from(userVerifiedDomains)
        .where(eq(userVerifiedDomains.userId, userId))
        .orderBy(userVerifiedDomains.createdAt, userVerifiedDomains.id),
      getUserNode(userId),
    ]);

    const activeNode = node && node.status === 'active' ? { endpoint: node.endpoint } : null;

    const document = buildDidDocument({
      _id: account.id,
      publicKey: account.publicKey,
      username: account.username,
      authMethods: authMethods.map((method) => ({
        type: method.type,
        metadata: { publicKey: method.methodPublicKey },
      })),
      verifiedDomains,
      type: account.type,
      federation: account.federationDomain ? { domain: account.federationDomain } : null,
      node: activeNode,
    });

    setDidHeaders(res);
    return res.json(document);
  } catch (err) {
    logger.error('DID document build failed', err instanceof Error ? err : new Error(String(err)), {
      component: 'did',
      method: 'GET /u/:userId/did.json',
    });
    return res
      .status(500)
      .json({ error: 'INTERNAL_SERVER_ERROR', message: 'Failed to build DID document' });
  }
});

export default router;
