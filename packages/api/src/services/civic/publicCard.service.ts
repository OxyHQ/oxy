/**
 * Public DNI Card Service (civic / Commons — Fase 1).
 *
 * Assembles the public, verifiable "DNI" card for a user and seals it with an
 * Oxy custodial attestation (`ES256K-DER-SHA256` over the canonical-JSON of the
 * card — the same scheme as the signed data export). A scanner resolves the card
 * by DID and verifies the Oxy signature OFFLINE, so the QR only ever carries the
 * DID (no trust data → nothing to spoof).
 *
 * The card composes ONLY public, canonical account fields: the DID, the
 * canonical `name.displayName` (via `formatUserResponse` — never recomposed),
 * the public `cloud.oxy.so` avatar URL, the reputation trust tier, verified
 * domains, and (empty until Fase 3/4) personhood status + credential badges.
 *
 * The attestation is `null` only when the Oxy signing key is unconfigured (dev /
 * pre-prod); in production it is always present — exactly like the export bundle.
 */

import type { PublicCard, SignedPublicCard, ExportAttestation, PersonhoodStatus as PersonhoodStatusValue } from '@oxyhq/contracts';
import { signedPublicCardSchema } from '@oxyhq/contracts';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { canonicalize } from '@oxyhq/protocol';
import { eq } from 'drizzle-orm';
import { getDb } from '../../config/postgres';
import { personhoodStatuses } from '../../db/schema/personhoodStatuses';
import { reputationBalances } from '../../db/schema/reputationBalances';
import { userVerifiedDomains } from '../../db/schema/userVerifiedDomains';
import { users } from '../../db/schema/users';
import SignatureService from '../signature.service';
import { buildUserDid, OXY_DID } from '../did.service';
import { formatUserResponse } from '../../utils/userTransform';
import { getAssetCdnUrl } from '../../config/cdn';
import { logger } from '../../utils/logger';

const ALG = 'ES256K-DER-SHA256' as const;

/**
 * Sign the card with the Oxy custodial key. Returns `null` (and logs) when
 * `OXY_PRIVATE_KEY`/`OXY_PUBLIC_KEY` are unconfigured — mirrors the export
 * bundle so the card never crashes on a missing key.
 *
 * The signature covers `canonicalize(card)`; the card is assembled with only the
 * keys that are actually present (optional `username`/`avatarUrl` are omitted,
 * not set to `undefined`), so a consumer re-canonicalizing the received card
 * derives byte-identical bytes.
 */
function signCard(card: PublicCard): ExportAttestation | null {
  const privateKey = process.env.OXY_PRIVATE_KEY;
  const publicKey = process.env.OXY_PUBLIC_KEY;
  if (!privateKey || !publicKey) {
    logger.warn('Public card attestation omitted: OXY_PRIVATE_KEY/OXY_PUBLIC_KEY not configured', {
      component: 'civic.publicCard',
    });
    return null;
  }
  const signature = SignatureService.signMessage(canonicalize(card), privateKey);
  return { issuer: OXY_DID, publicKey, alg: ALG, signature, signedAt: Date.now() };
}

/**
 * Build the signed public card for `userId`, or `null` when the user is absent.
 * The returned object is validated against `signedPublicCardSchema`.
 */
export async function buildSignedPublicCard(userId: string): Promise<SignedPublicCard | null> {
  // Explicit columns, not a whole-row read: `users` carries protected columns
  // (`phone`, the contact-discovery hashes, the refresh token) that a card must
  // never see, and drizzle returns every column unless the select names them.
  const [user] = await getDb()
    .select({
      _id: users.id,
      username: users.username,
      nameFirst: users.nameFirst,
      nameLast: users.nameLast,
      avatar: users.avatar,
      publicKey: users.publicKey,
      verified: users.verified,
      accountStatus: users.accountStatus,
      reputationTier: users.reputationTier,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (
    !user ||
    user.accountStatus === 'archived' ||
    user.reputationTier === 'restricted'
  ) {
    return null;
  }

  const formatted = formatUserResponse(user);
  const displayName =
    formatted?.name?.displayName ?? getNormalizedUserHandle(formatted) ?? '';
  const username = formatted?.username;
  const avatarId = formatted?.avatar;

  const [balance, personhood, domains] = await Promise.all([
    getDb()
      .select({ trustTier: reputationBalances.trustTier })
      .from(reputationBalances)
      .where(eq(reputationBalances.userId, userId))
      .limit(1),
    getDb()
      .select({ isRealPerson: personhoodStatuses.isRealPerson })
      .from(personhoodStatuses)
      .where(eq(personhoodStatuses.userId, userId))
      .limit(1),
    getDb()
      .select({ domain: userVerifiedDomains.domain })
      .from(userVerifiedDomains)
      .where(eq(userVerifiedDomains.userId, userId)),
  ]);
  const trustTier = balance[0]?.trustTier ?? 'new';

  // Personhood (Fase 3): a confirmed real person is `verified`; a user who has a
  // status row but has not yet crossed θ is `pending`; no row at all is
  // `unverified`.
  const personhoodStatus: PersonhoodStatusValue = !personhood[0]
    ? 'unverified'
    : personhood[0].isRealPerson
      ? 'verified'
      : 'pending';

  const verifiedDomains = domains.map((row) => row.domain);

  const card: PublicCard = {
    did: buildUserDid(userId),
    userId,
    name: displayName,
    trustTier,
    personhoodStatus,
    verifiedDomains,
    credentialBadges: [],
    issuedAt: Date.now(),
  };
  // Only attach optional keys when present so the signed canonical bytes match
  // what a consumer re-derives from the card it received.
  if (username) {
    card.username = username;
  }
  if (avatarId) {
    card.avatarUrl = `${getAssetCdnUrl()}/${avatarId}`;
  }

  const attestation = signCard(card);
  return signedPublicCardSchema.parse({ card, attestation });
}
