/**
 * The short-lived OAuth state of one linking flow — `linked_account_oauth_challenges`.
 *
 * Minting stores only the SHA-256 of the `state` parameter. Spending is ONE
 * transaction: lock the row that is unspent and unexpired, stamp `used_at`, and
 * wipe the PKCE verifier and provider state in the same UPDATE. A replayed or
 * late callback therefore finds nothing to spend (class A in `CONVENTIONS.md`;
 * the sweep in `db/expiry.ts` only reclaims storage).
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { LinkedAccountNetwork } from '@oxy.so/contracts';
import { getDb } from '../../config/postgres';
import { linkedAccountOauthChallenges } from '../../db/schema/userLinkedAccounts';
import type { VerifiedExternalAccount } from './common';

/** Ten minutes: long enough to sign in at the other network, short enough to be worthless later. */
const LINKED_ACCOUNT_CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** Five minutes for the app to hand the verified flow's `link_code` back with its session. */
const LINK_CODE_TTL_MS = 5 * 60 * 1000;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface NewChallenge {
  userId: string;
  network: LinkedAccountNetwork;
  /** The raw OAuth state; only its hash is stored. Absent for atproto (the library mints it). */
  state?: string;
  host?: string | null;
  pkceVerifier?: string | null;
  clientApplicationId: string;
  returnTo: string;
}

export interface MintedChallenge {
  id: string;
  expiresAt: Date;
}

export async function mintChallenge(input: NewChallenge): Promise<MintedChallenge> {
  const expiresAt = new Date(Date.now() + LINKED_ACCOUNT_CHALLENGE_TTL_MS);
  const [row] = await getDb()
    .insert(linkedAccountOauthChallenges)
    .values({
      userId: input.userId,
      network: input.network,
      stateHash: input.state === undefined ? null : sha256Hex(input.state),
      host: input.host ?? null,
      pkceVerifier: input.pkceVerifier ?? null,
      clientApplicationId: input.clientApplicationId,
      returnTo: input.returnTo,
      expiresAt,
    })
    .returning({ id: linkedAccountOauthChallenges.id, expiresAt: linkedAccountOauthChallenges.expiresAt });
  return row;
}

/** Everything a spent challenge hands back — the secrets exactly once. */
export interface SpentChallenge {
  id: string;
  userId: string;
  network: LinkedAccountNetwork;
  host: string | null;
  pkceVerifier: string | null;
  providerState: Record<string, unknown> | null;
  returnTo: string;
}

const SPEND_COLUMNS = {
  id: linkedAccountOauthChallenges.id,
  userId: linkedAccountOauthChallenges.userId,
  network: linkedAccountOauthChallenges.network,
  host: linkedAccountOauthChallenges.host,
  pkceVerifier: linkedAccountOauthChallenges.pkceVerifier,
  providerState: linkedAccountOauthChallenges.providerState,
  returnTo: linkedAccountOauthChallenges.returnTo,
};

/**
 * Spend the unexpired, unspent challenge whose state hashes to `state`, or
 * return `null` (unknown, expired, already spent, or another network's).
 */
export async function spendChallenge(network: LinkedAccountNetwork, state: string): Promise<SpentChallenge | null> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select(SPEND_COLUMNS)
      .from(linkedAccountOauthChallenges)
      .where(
        and(
          eq(linkedAccountOauthChallenges.stateHash, sha256Hex(state)),
          eq(linkedAccountOauthChallenges.network, network),
          isNull(linkedAccountOauthChallenges.usedAt),
          gt(linkedAccountOauthChallenges.expiresAt, sql`now()`),
        ),
      )
      .for('update')
      .limit(1);
    if (!row) return null;
    await tx
      .update(linkedAccountOauthChallenges)
      .set({ usedAt: sql`now()`, pkceVerifier: null, providerState: null })
      .where(eq(linkedAccountOauthChallenges.id, row.id));
    return row;
  });
}

/**
 * Attach the atproto library's own `state` and per-flow data to the row it was
 * started for (the row id travels as the library's `appState`). Refuses a row
 * that is spent, expired or already bound, so the binding happens once.
 */
export async function bindProviderState(
  challengeId: string,
  state: string,
  providerState: Record<string, unknown>,
  host: string | null,
): Promise<boolean> {
  const bound = await getDb()
    .update(linkedAccountOauthChallenges)
    .set({ stateHash: sha256Hex(state), providerState, host })
    .where(
      and(
        eq(linkedAccountOauthChallenges.id, challengeId),
        isNull(linkedAccountOauthChallenges.stateHash),
        isNull(linkedAccountOauthChallenges.usedAt),
        gt(linkedAccountOauthChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: linkedAccountOauthChallenges.id });
  return bound.length === 1;
}

/**
 * Record the account the network verified on the challenge the callback just
 * spent, and mint the one-time code the callback hands to `return_to`. Only
 * the code's hash is stored. Nothing is linked here: see `completeLinkedAccount`.
 */
export async function markChallengeVerified(challengeId: string, account: VerifiedExternalAccount): Promise<string> {
  const code = randomToken();
  const marked = await getDb()
    .update(linkedAccountOauthChallenges)
    .set({
      status: 'verified',
      accountKey: account.accountKey,
      actorUri: account.actorUri,
      handle: account.handle,
      host: account.host,
      linkCodeHash: sha256Hex(code),
      expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS),
    })
    .where(and(eq(linkedAccountOauthChallenges.id, challengeId), eq(linkedAccountOauthChallenges.status, 'pending')))
    .returning({ id: linkedAccountOauthChallenges.id });
  if (marked.length !== 1) throw new Error('linking challenge is not pending');
  return code;
}

/** The non-secret half of a (possibly spent) challenge — where a failed callback may return. */
export async function readChallengeReturn(challengeId: string): Promise<{ returnTo: string } | null> {
  const [row] = await getDb()
    .select({ returnTo: linkedAccountOauthChallenges.returnTo })
    .from(linkedAccountOauthChallenges)
    .where(eq(linkedAccountOauthChallenges.id, challengeId))
    .limit(1);
  return row ?? null;
}

/** Drop a challenge whose start failed before the user was sent anywhere. */
export async function discardChallenge(challengeId: string): Promise<void> {
  await getDb().delete(linkedAccountOauthChallenges).where(eq(linkedAccountOauthChallenges.id, challengeId));
}
