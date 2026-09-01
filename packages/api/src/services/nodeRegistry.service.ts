/**
 * Node Registry Service (self-sovereign identity layer — F5a user nodes)
 *
 * Materializes and maintains the operational `user_nodes` cache from the
 * AUTHORITATIVE source — a user's signed `type:'node'` record on their hash
 * chain (`collection: 'app.oxy.node'`, `rkey: 'self'`). The signed record is
 * verified + stored by the existing `POST /identity/records` path; this service
 * is the focused hook that projects its `record` payload into the fast cache and
 * keeps the liveness badge current.
 *
 * ## Absolute read-path invariant
 *
 * Every node fetch here goes through `@oxyhq/core/server`'s `safeFetch`
 * (HTTPS-only, private-IP denylist, DNS-pinned, bounded redirects) and runs ONLY
 * in the background — the post-registration probe (fire-and-forget) and the
 * periodic sweep. No function in a request's read path ever awaits a node: a
 * down node leaves the cache stale-but-instant. `probeLiveness` and
 * `sweepNodeLiveness` NEVER throw into a caller. Reading a node row is an
 * Oxy-DB read, so a node being down can never break a DID document.
 *
 * ## What the Postgres port changed, and why
 *
 * **`managed` and `controller` are ONE fact, so the option is one field.**
 * `user_nodes_managed_controller_check` refuses `(managed, controller)` pairs
 * that disagree, which Mongo could store happily. The old
 * `{ managed?: boolean; controller?: UserNodeController }` option could express
 * exactly the contradiction the CHECK now rejects — and since materialization is
 * deliberately non-throwing, a caller that passed `{ managed: true }` alone would
 * have had its vault silently not materialize. {@link MaterializeNodeOptions}
 * therefore carries a single `operator`, and both columns are derived from it.
 *
 * **Absent optionals are OMITTED, never `null`.** Drizzle hands back `null` for
 * an unset nullable column where a lean Mongoose document handed back
 * `undefined`, and `JSON.stringify` drops an `undefined` property while emitting
 * `"nodeDid": null` for a null. `GET /nodes/me` serializes these fields
 * directly, so {@link toUserNodeRecord} restores the absent-means-omitted shape
 * at the service boundary and the wire format is unchanged.
 *
 * **The sweep orders `NULLS FIRST`.** Mongo sorts a missing `lastProbeAt` ahead
 * of every date on an ascending sort; Postgres puts NULLs LAST by default. A
 * never-probed node IS the least-recently-probed one, so without the explicit
 * `nulls first` a freshly registered node would be starved by the sweep forever.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { signedRecordSigningInput } from '@oxyhq/protocol';
import { safeFetch } from '@oxyhq/core/server';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import {
  USER_NODE_CONTROLLERS,
  USER_NODE_MODES,
  USER_NODE_STATUSES,
  userNodes,
} from '../db/schema/userNodes';
import { users } from '../db/schema/users';
import SignatureService from './signature.service';
import { buildUserDid, OXY_DID } from './did.service';
import { getHead } from './repoLog.service';
import { verifyAndStoreRecord } from './signedRecord.service';
import userCache from '../utils/userCache';
import { logger } from '../utils/logger';
import {
  NODE_WELL_KNOWN_PATH,
  NODE_PROBE_TIMEOUT_MS,
  NODE_LAST_ERROR_MAX_LEN,
  NODE_LIVENESS_SWEEP_BATCH,
  NODE_COLLECTION,
  NODE_RKEY,
  MANAGED_NODE_BASE_URL_ENV,
  MANAGED_NODE_USER_PATH_PREFIX,
  MANAGED_NODE_PUBLIC_KEY_ENV,
  MANAGED_NODE_MODE,
} from '../utils/nodes.constants';

/** How records move: the node pulls (default), or Oxy pushes. */
export type UserNodeMode = (typeof USER_NODE_MODES)[number];
/** Who operates the node — the user self-hosting, or Oxy's managed vault. */
export type UserNodeController = (typeof USER_NODE_CONTROLLERS)[number];
/** Liveness badge, maintained only by background probes. */
export type UserNodeStatus = (typeof USER_NODE_STATUSES)[number];

/** One `user_nodes` row as stored, straight off drizzle. */
type UserNodeRow = typeof userNodes.$inferSelect;

/**
 * A user's node registration as every caller sees it.
 *
 * Identical to the stored row except that an unset optional column is ABSENT
 * rather than `null` — see the module header. `GET /nodes/me` serializes these
 * fields verbatim, so this is the wire contract, not a convenience.
 */
export interface UserNodeRecord {
  id: string;
  userId: string;
  /** DID the node advertises for itself. Informational. */
  nodeDid?: string;
  /** The node's public HTTPS base URL. */
  endpoint: string;
  /** The node's secp256k1 public key — records it signs verify against this. */
  nodePublicKey: string;
  mode: UserNodeMode;
  /** True when Oxy operates the node on the user's behalf (managed vault). */
  managed: boolean;
  controller: UserNodeController;
  status: UserNodeStatus;
  /** Last time a probe REACHED the node. */
  lastSeenAt?: Date;
  /** Last time a probe RAN, success or failure. */
  lastProbeAt?: Date;
  /** Why the last probe or ingest failed. Cleared on success. */
  lastError?: string;
  /** How far Oxy has mirrored the node's chain back in. */
  cursor?: number;
  /** Last ingest pull, including a caught-up no-op. */
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Drop every `null` optional so an absent value is ABSENT on the wire.
 *
 * The one place the null→undefined conversion happens; see the module header for
 * why it is a contract rather than a tidy-up.
 */
function toUserNodeRecord(row: UserNodeRow): UserNodeRecord {
  return {
    id: row.id,
    userId: row.userId,
    ...(row.nodeDid === null ? {} : { nodeDid: row.nodeDid }),
    endpoint: row.endpoint,
    nodePublicKey: row.nodePublicKey,
    mode: row.mode,
    managed: row.managed,
    controller: row.controller,
    status: row.status,
    ...(row.lastSeenAt === null ? {} : { lastSeenAt: row.lastSeenAt }),
    ...(row.lastProbeAt === null ? {} : { lastProbeAt: row.lastProbeAt }),
    ...(row.lastError === null ? {} : { lastError: row.lastError }),
    ...(row.cursor === null ? {} : { cursor: row.cursor }),
    ...(row.lastSyncedAt === null ? {} : { lastSyncedAt: row.lastSyncedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `ES256K-DER-SHA256` — the only signature alg carried by a signed record. */
const SIGNED_RECORD_ALG = 'ES256K-DER-SHA256' as const;

/** Retry budget for the multi-writer chain-head race when appending the node record. */
const MAX_PROVISION_ATTEMPTS = 4;

/** Statuses the liveness sweep re-probes — never `revoked`. */
const SWEEPABLE_STATUSES = ['active', 'unreachable'] as const satisfies readonly UserNodeStatus[];

/**
 * How a `type:'node'` record was projected into the cache.
 *
 * ONE field, because `managed` and `controller` are one fact and the schema
 * CHECK refuses a pair that disagrees — see the module header.
 */
export interface MaterializeNodeOptions {
  /** Operator of the node. Default `self` (the user self-hosts it). */
  operator?: UserNodeController;
}

/**
 * Shape of the `record` payload inside a signed `type:'node'` envelope. Only
 * these fields are projected into the cache; anything else is ignored. Kept API-
 * internal (not a published `@oxyhq/contracts` schema) until F5 stabilises.
 */
const nodeRecordSchema = z.object({
  endpoint: z.string().trim().min(1),
  nodePublicKey: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64,130}$/, 'nodePublicKey must be a secp256k1 hex key'),
  mode: z.enum(['pull', 'push']).optional(),
  nodeDid: z.string().trim().min(1).optional(),
});

/**
 * Validate + normalise a node endpoint. Returns the canonical `origin + path`
 * (trailing slash trimmed) only for a well-formed, credential-free HTTPS URL;
 * `null` otherwise. The SSRF/private-IP check itself happens later in `safeFetch`
 * at probe time — here we only reject endpoints that could never be a valid node
 * (so junk never reaches the DID document).
 */
function normalizeHttpsEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.hostname.length === 0) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** The liveness manifest URL for a normalised node endpoint. */
function wellKnownUrl(endpoint: string): string {
  return `${endpoint}${NODE_WELL_KNOWN_PATH}`;
}

/**
 * Project a verified `type:'node'` signed record into the `user_nodes` cache.
 *
 * Best-effort and non-throwing: the signed record is the source of truth and is
 * already persisted on the chain by the caller; a malformed `record` payload
 * (bad endpoint/key) simply skips materialization (logged) rather than failing
 * the request. On success the row is upserted `active`, the user cache is
 * invalidated (the DID document's `#oxy-node` service entry changed), and a
 * liveness probe is fired WITHOUT being awaited.
 *
 * `options.operator` records WHO runs the node: self-hosted by default, or
 * `'oxy'` for an F5c managed vault. It is written every time, so re-registering
 * a self-hosted node over a previously managed one (or vice-versa) flips the
 * operator deterministically.
 *
 * The upsert keeps `id` and `created_at` insert-only (they are absent from the
 * conflict set) and rewrites every projected field, so re-materializing the same
 * record is idempotent apart from `updated_at`.
 */
export async function materializeNodeFromRecord(
  userId: string,
  record: Record<string, unknown>,
  options: MaterializeNodeOptions = {},
): Promise<UserNodeRecord | null> {
  const parsed = nodeRecordSchema.safeParse(record);
  if (!parsed.success) {
    logger.warn('node record payload failed validation; skipping materialization', {
      component: 'nodeRegistry',
      userId,
    });
    return null;
  }

  const endpoint = normalizeHttpsEndpoint(parsed.data.endpoint);
  if (!endpoint) {
    logger.warn('node record endpoint is not a valid HTTPS URL; skipping materialization', {
      component: 'nodeRegistry',
      userId,
    });
    return null;
  }

  const mode: UserNodeMode = parsed.data.mode ?? 'pull';
  const controller: UserNodeController = options.operator ?? 'self';
  const managed = controller === 'oxy';

  // Written on both the insert and the conflict path. `nodeDid` is conditional:
  // a record that omits it leaves whatever the row already advertised, exactly
  // as the Mongo `$set` did.
  const projection = {
    endpoint,
    nodePublicKey: parsed.data.nodePublicKey,
    mode,
    managed,
    controller,
    status: 'active' as const,
    lastError: null,
    ...(parsed.data.nodeDid ? { nodeDid: parsed.data.nodeDid } : {}),
  };

  try {
    const [row] = await getDb()
      .insert(userNodes)
      .values({ userId, ...projection })
      .onConflictDoUpdate({
        target: userNodes.userId,
        // `$onUpdate` does NOT fire for an upsert's conflict set, so
        // `updated_at` is bumped explicitly or it would freeze at the insert.
        set: { ...projection, updatedAt: new Date() },
      })
      .returning();

    // The DID document derives its `#oxy-node` service entry from this row, so a
    // (re)registration changes user-facing state — invalidate the user cache.
    userCache.invalidate(userId);

    // Fire-and-forget liveness probe — NEVER awaited in the request path.
    probeLiveness(userId).catch((err) =>
      logger.debug('post-registration node liveness probe failed to schedule', {
        component: 'nodeRegistry',
        userId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    return toUserNodeRecord(row);
  } catch (err) {
    logger.error(
      'failed to materialize user node from signed record',
      err instanceof Error ? err : new Error(String(err)),
      { component: 'nodeRegistry', userId },
    );
    return null;
  }
}

/** The liveness columns a probe writes. A failed probe leaves `lastSeenAt` alone. */
type LivenessUpdate = {
  status: UserNodeStatus;
  lastProbeAt: Date;
  lastError: string | null;
  lastSeenAt?: Date;
};

/**
 * Background liveness probe for a single user's node. Fetches the node's
 * `/.well-known/oxy-node.json` over `safeFetch` (SSRF-safe) and updates the
 * cached badge: a 2xx → `active` + `lastSeenAt`; anything else (or a thrown
 * fetch error) → `unreachable` + `lastError`. Never throws and never reads more
 * than the response headers (the body is destroyed immediately — only liveness
 * matters here). A `revoked` node is skipped.
 */
export async function probeLiveness(userId: string): Promise<void> {
  try {
    const [node] = await getDb()
      .select({ endpoint: userNodes.endpoint })
      .from(userNodes)
      .where(and(eq(userNodes.userId, userId), ne(userNodes.status, 'revoked')))
      .limit(1);
    if (!node) {
      return;
    }

    const probeAt = new Date();
    let update: LivenessUpdate;

    try {
      const result = await safeFetch(wellKnownUrl(node.endpoint), {
        headersTimeoutMs: NODE_PROBE_TIMEOUT_MS,
        maxRedirects: 1,
      });
      // Liveness only needs the status line — drop the body without reading it.
      result.response.destroy();

      if (result.status >= 200 && result.status < 300) {
        update = { status: 'active', lastSeenAt: probeAt, lastProbeAt: probeAt, lastError: null };
      } else {
        update = {
          status: 'unreachable',
          lastProbeAt: probeAt,
          lastError: `node responded with HTTP ${result.status}`.slice(0, NODE_LAST_ERROR_MAX_LEN),
        };
      }
    } catch (fetchErr) {
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      update = {
        status: 'unreachable',
        lastProbeAt: probeAt,
        lastError: message.slice(0, NODE_LAST_ERROR_MAX_LEN),
      };
      logger.debug('node liveness probe failed', { component: 'nodeRegistry', userId, error: message });
    }

    await getDb()
      .update(userNodes)
      .set(update)
      .where(and(eq(userNodes.userId, userId), ne(userNodes.status, 'revoked')));
  } catch (err) {
    // A DB error during a background probe must never escape — log and move on.
    logger.error(
      'node liveness probe encountered an error',
      err instanceof Error ? err : new Error(String(err)),
      { component: 'nodeRegistry', userId },
    );
  }
}

/**
 * Re-probe a bounded batch of registered nodes (least-recently-probed first).
 * Sequential to bound the outbound concurrency; each probe is independent and
 * non-throwing. Called by the unref'd background sweep in `server.ts`.
 *
 * `nulls first` is load-bearing: a node that has NEVER been probed is the
 * least-recently-probed one, and Postgres would otherwise sort it last and
 * starve it. See the module header.
 */
export async function sweepNodeLiveness(): Promise<void> {
  const nodes = await getDb()
    .select({ userId: userNodes.userId })
    .from(userNodes)
    .where(inArray(userNodes.status, [...SWEEPABLE_STATUSES]))
    .orderBy(sql`${userNodes.lastProbeAt} asc nulls first`)
    .limit(NODE_LIVENESS_SWEEP_BATCH);

  for (const node of nodes) {
    await probeLiveness(node.userId);
  }
}

/** The cached node row for a user (any status), or `null`. */
export async function getUserNode(userId: string): Promise<UserNodeRecord | null> {
  const [row] = await getDb()
    .select()
    .from(userNodes)
    .where(eq(userNodes.userId, userId))
    .limit(1);
  return row ? toUserNodeRecord(row) : null;
}

/**
 * Revoke a user's node registration (mark `revoked` so it leaves the DID document
 * and the liveness sweeps). Returns `true` when a non-revoked row was flipped.
 * Invalidates the user cache because the DID `#oxy-node` service entry changed.
 *
 * Operator-agnostic: it revokes a self-hosted node and an F5c MANAGED vault
 * identically — flipping `status` to `revoked` is the entire control-plane action.
 *
 * ## Managed-vault teardown seam (infra, out-of-band)
 *
 * For a managed vault (`managed:true, controller:'oxy'`) the underlying container
 * + on-disk storage are an INFRASTRUCTURE concern, not an API concern. Revoking
 * here is the durable, idempotent signal: a node-fleet reconciler tears down (or
 * archives) the per-user volume by reconciling against the managed, Oxy-operated,
 * `revoked` rows of `user_nodes`. The API never reaches the node inline (the
 * read-path invariant), so this stays a pure local DB write; the heavy teardown
 * happens asynchronously in the fleet.
 */
export async function removeNode(userId: string): Promise<boolean> {
  const revoked = await getDb()
    .update(userNodes)
    .set({ status: 'revoked', lastError: null })
    .where(and(eq(userNodes.userId, userId), ne(userNodes.status, 'revoked')))
    .returning({ id: userNodes.id });
  const changed = revoked.length > 0;
  if (changed) {
    userCache.invalidate(userId);
  }
  return changed;
}

/* -------------------------------------------------------------------------- */
/*  F5c — managed vault provisioning                                          */
/* -------------------------------------------------------------------------- */

/** Why {@link provisionManagedVault} could not provision a managed vault. */
export type ManagedVaultFailureReason =
  | 'oxy_key_unconfigured'
  | 'managed_endpoint_unconfigured'
  | 'user_not_found'
  | 'provision_failed';

/** Result of {@link provisionManagedVault} — the active row, or a clear reason. */
export type ProvisionManagedVaultResult =
  | { ok: true; node: UserNodeRecord }
  | { ok: false; reason: ManagedVaultFailureReason };

/** The managed node's signing public key: a dedicated fleet key, else the Oxy custodial key. */
function resolveManagedNodePublicKey(): string | undefined {
  return process.env[MANAGED_NODE_PUBLIC_KEY_ENV] || process.env.OXY_PUBLIC_KEY || undefined;
}

/**
 * Derive the managed-node endpoint for a user from `MANAGED_NODE_BASE_URL`
 * (`${base}/u/${userId}`), validated/normalised as a credential-free HTTPS URL.
 * Returns `null` when the base is unset or not a usable HTTPS base — provisioning
 * then fails closed rather than registering a junk endpoint.
 */
function resolveManagedEndpoint(userId: string): string | null {
  const base = process.env[MANAGED_NODE_BASE_URL_ENV];
  if (!base) {
    return null;
  }
  const trimmed = base.replace(/\/+$/, '');
  return normalizeHttpsEndpoint(`${trimmed}${MANAGED_NODE_USER_PATH_PREFIX}${userId}`);
}

/**
 * Provision (or refresh) an Oxy-operated MANAGED vault for `userId` — the F5c
 * "Create your vault" convenience for non-technical users.
 *
 * Oxy custodial-signs a `type:'node'` record onto the user's hash chain (issuer =
 * `OXY_DID`, signed by the Oxy custodial key — the SAME mechanism as the
 * reputation attestation, signed export, and F5b ingest witness), runs it through
 * the shared {@link verifyAndStoreRecord} so it lands on the chain exactly like a
 * self-signed node record, then materializes the `user_nodes` cache as
 * `managed:true, controller:'oxy', status:'active'` and fires the async liveness
 * probe. `userCache.invalidate` lets the DID `#oxy-node` service entry resolve.
 *
 * Fails closed: with no Oxy custodial key (`oxy_key_unconfigured`) or no
 * configured managed-node base URL (`managed_endpoint_unconfigured`) it returns a
 * clear error instead of creating a broken vault.
 *
 * Idempotent: re-provisioning while an active managed vault already exists at the
 * same endpoint is a no-op refresh (re-probe + cache invalidate) — it does NOT
 * append another chain record. The container/storage orchestration itself is
 * INFRA (a node-fleet reconciler stands up the per-user volume off the active
 * managed row); this layer only writes the cryptographic registration.
 */
export async function provisionManagedVault(userId: string): Promise<ProvisionManagedVaultResult> {
  const privateKey = process.env.OXY_PRIVATE_KEY;
  const oxyPublicKey = process.env.OXY_PUBLIC_KEY;
  if (!privateKey || !oxyPublicKey) {
    logger.warn('Managed vault refused: OXY_PRIVATE_KEY/OXY_PUBLIC_KEY not configured', {
      component: 'nodeRegistry',
      userId,
    });
    return { ok: false, reason: 'oxy_key_unconfigured' };
  }

  const endpoint = resolveManagedEndpoint(userId);
  if (!endpoint) {
    logger.warn('Managed vault refused: MANAGED_NODE_BASE_URL unset or not a valid HTTPS base', {
      component: 'nodeRegistry',
      userId,
    });
    return { ok: false, reason: 'managed_endpoint_unconfigured' };
  }

  const nodePublicKey = resolveManagedNodePublicKey();
  if (!nodePublicKey) {
    // Unreachable while `oxyPublicKey` is set, but keeps the result type total.
    return { ok: false, reason: 'oxy_key_unconfigured' };
  }

  const [user] = await getDb().select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    return { ok: false, reason: 'user_not_found' };
  }

  // Idempotency: an already-active managed vault at this endpoint is a no-op
  // refresh — re-assert the cache + re-probe, but do NOT grow the chain.
  const existing = await getUserNode(userId);
  if (
    existing &&
    existing.managed === true &&
    existing.controller === 'oxy' &&
    existing.status !== 'revoked' &&
    existing.endpoint === endpoint
  ) {
    userCache.invalidate(userId);
    probeLiveness(userId).catch((err) =>
      logger.debug('managed vault refresh probe failed to schedule', {
        component: 'nodeRegistry',
        userId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { ok: true, node: existing };
  }

  const subjectDid = buildUserDid(userId);
  const record: Record<string, unknown> = {
    endpoint,
    nodePublicKey,
    mode: MANAGED_NODE_MODE,
    managed: true,
  };

  let stored = false;
  for (let attempt = 0; attempt < MAX_PROVISION_ATTEMPTS; attempt += 1) {
    const head = await getHead(userId);
    const seq = head ? head.seq + 1 : 0;
    const prev = head ? head.headRecordId : null;

    const fields: Omit<SignedRecordEnvelope, 'signature'> = {
      version: 2,
      type: 'node',
      subject: subjectDid,
      issuer: OXY_DID,
      record,
      issuedAt: Date.now(),
      seq,
      prev,
      collection: NODE_COLLECTION,
      rkey: NODE_RKEY,
      publicKey: oxyPublicKey,
      alg: SIGNED_RECORD_ALG,
    };
    const signature = SignatureService.signMessage(signedRecordSigningInput(fields), privateKey);
    const envelope: SignedRecordEnvelope = { ...fields, signature };

    // The subject account's own verification methods are NOT consulted for a
    // custodial record (issuer === OXY_DID); the resolver resolves the subject.
    const result = await verifyAndStoreRecord(envelope, userId);
    if (result.ok) {
      stored = true;
      break;
    }

    // A concurrent writer advanced the chain head between our read and write —
    // re-read the head and retry. Anything else is a hard failure.
    if (result.reason === 'chain_conflict' || result.reason === 'bad_seq' || result.reason === 'chain_fork') {
      continue;
    }

    logger.warn('Managed vault node record rejected', {
      component: 'nodeRegistry',
      userId,
      reason: result.reason,
    });
    return { ok: false, reason: 'provision_failed' };
  }

  if (!stored) {
    logger.warn('Managed vault abandoned after chain-race retries', {
      component: 'nodeRegistry',
      userId,
    });
    return { ok: false, reason: 'provision_failed' };
  }

  // Project the just-signed record into the operational cache as an Oxy-operated
  // managed node (active) + fire the async liveness probe + invalidate the user
  // cache (so the DID `#oxy-node` service entry resolves).
  const node = await materializeNodeFromRecord(userId, record, { operator: 'oxy' });
  if (!node) {
    logger.error(
      'Managed vault chain record stored but cache materialization failed',
      new Error('materializeNodeFromRecord returned null'),
      { component: 'nodeRegistry', userId },
    );
    return { ok: false, reason: 'provision_failed' };
  }

  return { ok: true, node };
}
