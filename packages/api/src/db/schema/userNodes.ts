/**
 * `user_nodes` — the operational cache of a user's registered personal data node.
 *
 * Ported from `models/UserNode.ts`. The AUTHORITY for a registration is a signed
 * `node` record on the user's chain (`app.oxy.node`, `rkey: 'self'`,
 * last-writer-wins); this row is the denormalised projection plus the liveness
 * state background probes maintain.
 *
 * The read-path invariant travels unchanged: nothing in a request's read path
 * touches a node. `status` / `last_seen_at` / `last_probe_at` / `last_error` /
 * `cursor` / `last_synced_at` are written ONLY by background probes and the
 * ingest worker, so a node being down makes this row stale-but-instant rather
 * than slow.
 *
 * One node per account (`user_id` unique); re-registration upserts in place.
 *
 * `node_public_key` deliberately carries no uniqueness constraint: two accounts
 * legitimately share one host in the managed-vault model (`controller: 'oxy'`),
 * where Oxy operates the node on the user's behalf.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** How records move: the node pulls (default), or Oxy pushes. */
export const USER_NODE_MODES = ['pull', 'push'] as const;

/** Who operates the node — the user self-hosting, or Oxy's managed vault. */
export const USER_NODE_CONTROLLERS = ['self', 'oxy'] as const;

/** Liveness badge, maintained only by background probes. */
export const USER_NODE_STATUSES = ['active', 'unreachable', 'revoked'] as const;

export const userNodes = pgTable(
  'user_nodes',
  {
    id: generatedId(),
    /** `CASCADE` — a node registration for an account that no longer exists is unreachable by construction. */
    userId: text()
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** DID the node advertises for itself. Informational. */
    nodeDid: text(),
    /** The node's public HTTPS base URL. */
    endpoint: text().notNull(),
    /** The node's secp256k1 public key — records it signs verify against this. */
    nodePublicKey: text().notNull(),
    mode: text({ enum: USER_NODE_MODES }).notNull().default('pull'),
    /** True when Oxy operates the node on the user's behalf (managed vault). */
    managed: boolean().notNull().default(false),
    controller: text({ enum: USER_NODE_CONTROLLERS }).notNull().default('self'),
    status: text({ enum: USER_NODE_STATUSES }).notNull().default('active'),
    /** Last time a probe REACHED the node. */
    lastSeenAt: timestamptz(),
    /** Last time a probe RAN, success or failure. */
    lastProbeAt: timestamptz(),
    /** Why the last probe or ingest failed. Cleared on success. */
    lastError: text(),
    /** How far Oxy has mirrored the node's chain back in. Advanced only by the ingest worker. */
    cursor: integer(),
    /** Last ingest pull, including a caught-up no-op. */
    lastSyncedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Liveness sweeps scan by status (`active`/`unreachable`, never `revoked`).
    index('user_nodes_status_idx').on(t.status),

    check('user_nodes_mode_check', sql`${t.mode} in (${sql.raw(inList(USER_NODE_MODES))})`),
    check(
      'user_nodes_controller_check',
      sql`${t.controller} in (${sql.raw(inList(USER_NODE_CONTROLLERS))})`
    ),
    check('user_nodes_status_check', sql`${t.status} in (${sql.raw(inList(USER_NODE_STATUSES))})`),
    check('user_nodes_cursor_check', sql`${t.cursor} is null or ${t.cursor} >= 0`),
    // `managed` and `controller` are two spellings of one fact and every writer
    // sets them together (`provisionManagedVault`). Mongo could store the
    // contradiction "managed by nobody"; the CHECK makes it unrepresentable
    // rather than leaving two readers to disagree about which field wins.
    check(
      'user_nodes_managed_controller_check',
      sql`(${t.managed} = true and ${t.controller} = 'oxy') or (${t.managed} = false and ${t.controller} = 'self')`
    ),
  ]
);
