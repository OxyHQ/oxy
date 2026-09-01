/**
 * Graph-exclusion utility (civic / Commons — Fase 2 anti-sybil core).
 *
 * The SHARED sock-puppet test used by BOTH the real-life attestation flow
 * (counterparty must not be the subject's puppet) and the validator jury
 * selection (a candidate juror related to the subject is excluded). Centralised
 * here so both paths apply identical rules.
 *
 * Two signals:
 *  1. SOCIAL GRAPH — a directed/undirected edge via `user_follows` (user
 *     follows) or `blocks` (either direction), within a configurable hop radius
 *     (1 = direct neighbour; 2 = shares a common neighbour). Two-hop is computed
 *     as the intersection of the two users' direct-neighbour sets (bounded, no
 *     BFS blow-up).
 *  2. SHARED DEVICE — an overlap in the `device_id` of the two users' active
 *     sessions (a classic multi-account signal). IP is deliberately NOT a
 *     signal: the platform stores no user IP addresses at rest (privacy
 *     invariant — see docs/superpowers/specs/2026-07-14-no-ip-storage-design.md).
 *     `deviceInfo.fingerprint` is also NOT a device signal here — see
 *     {@link sessionDeviceIds}.
 *
 * `contacts` is intentionally NOT used: it keys on email, not a resolved Oxy
 * user id, so it does not yield a user↔user edge without a privacy-sensitive
 * email join — left out of the v1 exclusion set.
 *
 * The Mongo `Follow` model carried a `followType` discriminator because one
 * collection held user AND topic follows; `user_follows` is user-follows only,
 * so the discriminator has no counterpart and its filter does not travel.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../config/postgres';
import { blocks } from '../../db/schema/blocks';
import { sessions } from '../../db/schema/sessions';
import { userFollows } from '../../db/schema/userFollows';

/** Why two users were judged related (for audit + a machine-readable reason). */
export type ExclusionReason = 'self' | 'graph_neighbor' | 'shared_device';

export type ExclusionResult =
  | { excluded: false }
  | { excluded: true; reason: ExclusionReason };

/**
 * The set of a user's DIRECT graph neighbours (as id strings): everyone they
 * follow, everyone who follows them, and either side of a block edge.
 */
async function directNeighbors(userId: string): Promise<Set<string>> {
  const [followsOut, followsIn, blocksOut, blocksIn] = await Promise.all([
    getDb()
      .select({ id: userFollows.followedId })
      .from(userFollows)
      .where(eq(userFollows.followerId, userId)),
    getDb()
      .select({ id: userFollows.followerId })
      .from(userFollows)
      .where(eq(userFollows.followedId, userId)),
    getDb().select({ id: blocks.blockedId }).from(blocks).where(eq(blocks.userId, userId)),
    getDb().select({ id: blocks.userId }).from(blocks).where(eq(blocks.blockedId, userId)),
  ]);

  const set = new Set<string>();
  for (const rows of [followsOut, followsIn, blocksOut, blocksIn]) {
    for (const row of rows) {
      set.add(row.id);
    }
  }
  return set;
}

/**
 * True when `a` and `b` are within `hops` social-graph hops. `hops === 1` is a
 * direct edge; `hops >= 2` additionally treats a shared direct neighbour as
 * related.
 */
export async function areGraphRelated(a: string, b: string, hops = 1): Promise<boolean> {
  if (a === b) {
    return true;
  }
  const neighborsA = await directNeighbors(a);
  if (neighborsA.has(b)) {
    return true;
  }
  if (hops >= 2) {
    const neighborsB = await directNeighbors(b);
    if (neighborsB.has(a)) {
      return true;
    }
    for (const x of neighborsA) {
      if (neighborsB.has(x)) {
        return true;
      }
    }
  }
  return false;
}

/** Collect a user's active-session device ids. Exported so the Fase 3 sybil
 * heuristics can cluster accounts by shared deviceId without re-implementing the
 * extraction.
 *
 * IPs are deliberately NOT collected: the platform stores no user IP addresses
 * at rest (privacy invariant — see
 * docs/superpowers/specs/2026-07-14-no-ip-storage-design.md).
 *
 * `deviceInfo.fingerprint` is deliberately EXCLUDED from the device set: it is
 * the sha256 of a client-supplied environment blob ({userAgent, platform,
 * language, timezone, screen}), which on React Native carries ZERO
 * device-unique inputs (no `screen` global, mostly-undefined navigator
 * fields) — two DISTINCT physical phones with the same locale/timezone
 * deterministically produce the SAME fingerprint. Treating it as device
 * identity falsely excluded two separate devices as one
 * (`excluded_shared_device`). `deviceId` is the high-confidence per-install
 * identifier: device-first installs persist a random 256-bit id that is
 * shared across accounts on the SAME install (the SDK threads it into every
 * additional sign-in), while the server-derived fallback is salted +
 * user-scoped and can never collide across users — so a genuine
 * multi-account-on-one-device pair still overlaps on `deviceId`. */
export async function sessionDeviceIds(userId: string): Promise<Set<string>> {
  return sessionDeviceIdsFor([userId]).then((byUser) => byUser.get(userId) ?? new Set<string>());
}

/**
 * The active-session device ids of SEVERAL accounts, in one round trip.
 *
 * The sybil clustering asks this for a subject plus every one of their vouchers,
 * which under the Mongo shape was one query per account. `device_id` is
 * `NOT NULL` on `sessions`, so a row always contributes an id.
 */
export async function sessionDeviceIdsFor(userIds: string[]): Promise<Map<string, Set<string>>> {
  const byUser = new Map<string, Set<string>>();
  for (const userId of userIds) {
    byUser.set(userId, new Set<string>());
  }
  if (userIds.length === 0) {
    return byUser;
  }

  const rows = await getDb()
    .select({ userId: sessions.userId, deviceId: sessions.deviceId })
    .from(sessions)
    .where(and(inArray(sessions.userId, userIds), eq(sessions.isActive, true)));

  for (const row of rows) {
    byUser.get(row.userId)?.add(row.deviceId);
  }
  return byUser;
}

/** True when `a` and `b` share an active-session deviceId. */
export async function shareDevice(a: string, b: string): Promise<boolean> {
  const byUser = await sessionDeviceIdsFor([a, b]);
  const da = byUser.get(a) ?? new Set<string>();
  const db = byUser.get(b) ?? new Set<string>();
  for (const device of da) {
    if (db.has(device)) {
      return true;
    }
  }
  return false;
}

/**
 * The shared sock-puppet test: `a` and `b` are excluded from attesting/judging
 * each other when they are the same account, within `hops` graph hops, or share
 * an active-session deviceId. Returns the FIRST matching reason.
 */
export async function isSockPuppetRelation(
  a: string,
  b: string,
  opts: { hops?: number } = {},
): Promise<ExclusionResult> {
  if (a === b) {
    return { excluded: true, reason: 'self' };
  }
  if (await areGraphRelated(a, b, opts.hops ?? 1)) {
    return { excluded: true, reason: 'graph_neighbor' };
  }
  if (await shareDevice(a, b)) {
    return { excluded: true, reason: 'shared_device' };
  }
  return { excluded: false };
}
