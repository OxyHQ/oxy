/**
 * The public Oxy ID card (civic / Fase 1), against a REAL Postgres.
 *
 * The suite this replaces mocked `User`, `ReputationBalance` and
 * `PersonhoodStatus` as Mongoose models the service no longer imports, so every
 * "assertion" was really a statement about the mock's `.select().lean()` chain.
 * The card is now assembled from FOUR tables — `users`, `reputation_balances`,
 * `personhood_statuses` and the `user_verified_domains` child table — and the
 * three composition rules that can silently break are exactly the ones a mock
 * cannot vouch for:
 *
 *  - **The card is the OFFLINE contract.** A Commons scanner resolves a DID,
 *    re-canonicalizes the card it received, and checks the Oxy signature without
 *    talking to us again. That only works if the signed bytes are derivable from
 *    the card alone — which is why the optional keys are OMITTED rather than set
 *    to `undefined`, and why the tamper case below is the assertion that matters
 *    (a signature test that only verifies the untouched card passes against a
 *    signature computed over a constant).
 *  - **`personhoodStatus` is TRI-state**, and the two false-ish states are
 *    distinct: no row at all is `unverified`, a row below θ is `pending`. A
 *    fixture that only exercises "row present, real person" cannot tell them
 *    apart.
 *  - **The card must carry no protected column.** `users` holds the phone, the
 *    contact-discovery hashes and the live refresh token; drizzle returns every
 *    column unless the select names them, so the key set is asserted exactly.
 *
 * The whole run shares one database, so every account carries a per-test random
 * id and no assertion depends on a table being empty.
 */

import { randomUUID } from 'node:crypto';
import { ec as EC } from 'elliptic';
import { eq } from 'drizzle-orm';
import { canonicalize } from '@oxyhq/protocol';
import type { PublicCard } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { personhoodStatuses } from '../../db/schema/personhoodStatuses';
import { reputationBalances } from '../../db/schema/reputationBalances';
import { userVerifiedDomains } from '../../db/schema/userVerifiedDomains';
import { users } from '../../db/schema/users';
import { buildSignedPublicCard } from '../civic/publicCard.service';
import SignatureService from '../signature.service';
import { buildUserDid, OXY_DID } from '../did.service';
import { getAssetCdnUrl } from '../../config/cdn';

const ec = new EC('secp256k1');
const oxyKey = ec.genKeyPair();
const OXY_PUBLIC = oxyKey.getPublic('hex');
const OXY_PRIVATE = oxyKey.getPrivate('hex');

const uniqueId = () => randomUUID().replace(/-/g, '');

/** An account, with only the fields the card is allowed to read. */
async function makeUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({
      id,
      username: `card${id.slice(0, 12)}`,
      nameFirst: 'Nate',
      nameLast: 'Isern',
      avatar: `file${id.slice(0, 8)}`,
      ...overrides,
    });
  return id;
}

async function seedBalance(userId: string, trustTier: typeof reputationBalances.$inferInsert['trustTier']) {
  await getDb().insert(reputationBalances).values({ userId, trustTier });
}

async function seedPersonhood(userId: string, isRealPerson: boolean) {
  await getDb()
    .insert(personhoodStatuses)
    .values({ userId, isRealPerson, score: isRealPerson ? 0.9 : 0.2 });
}

beforeAll(async () => {
  await connectPostgres();
  process.env.OXY_PRIVATE_KEY = OXY_PRIVATE;
  process.env.OXY_PUBLIC_KEY = OXY_PUBLIC;
});

afterAll(async () => {
  delete process.env.OXY_PRIVATE_KEY;
  delete process.env.OXY_PUBLIC_KEY;
  await closePostgres();
});

describe('the card is assembled from the stored rows', () => {
  it('reads the name, handle, avatar, tier and domains out of four tables', async () => {
    const userId = await makeUser();
    await seedBalance(userId, 'trusted');
    const domain = `${uniqueId().slice(0, 10)}.example`;
    await getDb()
      .insert(userVerifiedDomains)
      .values({ userId, domain, verifiedAt: new Date(), method: 'dns-txt' });

    const signed = await buildSignedPublicCard(userId);
    expect(signed).not.toBeNull();
    if (!signed) return;

    const [stored] = await getDb()
      .select({ username: users.username, avatar: users.avatar })
      .from(users)
      .where(eq(users.id, userId));

    expect(signed.card.did).toBe(buildUserDid(userId));
    expect(signed.card.userId).toBe(userId);
    expect(signed.card.name).toBe('Nate Isern');
    expect(signed.card.username).toBe(stored.username);
    expect(signed.card.avatarUrl).toBe(`${getAssetCdnUrl()}/${stored.avatar}`);
    expect(signed.card.trustTier).toBe('trusted');
    // The child table is the only source of these — an unrelated account's
    // domains must not leak in.
    expect(signed.card.verifiedDomains).toEqual([domain]);
    expect(signed.card.credentialBadges).toEqual([]);
    expect(typeof signed.card.issuedAt).toBe('number');
  });

  it('carries EXACTLY the public keys — no protected column rides along', async () => {
    // `users` holds `phone`, `hashed_email`, `hashed_phone` and the live refresh
    // token. Drizzle returns every column unless the select names them, so the
    // guarantee here is the key SET, not the presence of the ones we want.
    const userId = await makeUser();
    const signed = await buildSignedPublicCard(userId);
    if (!signed) throw new Error('expected a card');

    expect(Object.keys(signed.card).sort()).toEqual([
      'avatarUrl',
      'credentialBadges',
      'did',
      'issuedAt',
      'name',
      'personhoodStatus',
      'trustTier',
      'userId',
      'username',
      'verifiedDomains',
    ]);
  });

  it('falls back to the handle when the account has no real name', async () => {
    const userId = await makeUser({ nameFirst: null, nameLast: null });
    const signed = await buildSignedPublicCard(userId);
    if (!signed) throw new Error('expected a card');

    const [stored] = await getDb()
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, userId));
    expect(signed.card.name).toBe(stored.username);
    expect(signed.card.name.length).toBeGreaterThan(0);
  });

  it('OMITS the optional keys when absent rather than setting them undefined', async () => {
    // The signature covers `canonicalize(card)`. A present-but-undefined key and
    // an absent one canonicalize differently, so a scanner rebuilding the card
    // from the wire would derive different bytes and the offline check would
    // fail for a reason nothing reports.
    const userId = await makeUser({ username: null, avatar: null, nameFirst: 'Solo', nameLast: null });
    const signed = await buildSignedPublicCard(userId);
    if (!signed) throw new Error('expected a card');

    expect('username' in signed.card).toBe(false);
    expect('avatarUrl' in signed.card).toBe(false);
  });

  it('defaults the tier to "new" when the account has no balance row', async () => {
    const userId = await makeUser();
    const signed = await buildSignedPublicCard(userId);
    expect(signed?.card.trustTier).toBe('new');
  });
});

describe('personhoodStatus is tri-state', () => {
  it('reads "unverified" when there is no personhood row at all', async () => {
    const userId = await makeUser();
    const signed = await buildSignedPublicCard(userId);
    expect(signed?.card.personhoodStatus).toBe('unverified');
  });

  it('reads "pending" for a row that has NOT crossed θ', async () => {
    // The discriminating half: `pending` and `unverified` are both "not a
    // confirmed person", and a service that collapsed them would still pass a
    // suite that only ever seeded a real person.
    const userId = await makeUser();
    await seedPersonhood(userId, false);
    const signed = await buildSignedPublicCard(userId);
    expect(signed?.card.personhoodStatus).toBe('pending');
  });

  it('reads "verified" for a confirmed real person', async () => {
    const userId = await makeUser();
    await seedPersonhood(userId, true);
    const signed = await buildSignedPublicCard(userId);
    expect(signed?.card.personhoodStatus).toBe('verified');
  });
});

describe('the Oxy attestation is what a scanner checks offline', () => {
  it('verifies over the canonical card with the Oxy custodial key', async () => {
    const userId = await makeUser();
    await seedBalance(userId, 'high_trust');

    const signed = await buildSignedPublicCard(userId);
    if (!signed?.attestation) throw new Error('expected an attested card');

    expect(signed.attestation.issuer).toBe(OXY_DID);
    expect(signed.attestation.alg).toBe('ES256K-DER-SHA256');
    expect(signed.attestation.publicKey).toBe(OXY_PUBLIC);
    expect(
      SignatureService.verifySignature(
        canonicalize(signed.card),
        signed.attestation.signature,
        signed.attestation.publicKey,
      ),
    ).toBe(true);
  });

  it('FAILS once a single field of the card is altered', async () => {
    // The assertion the untouched-card check cannot make: a signature computed
    // over a constant, or a verifier that ignores its message, passes that one
    // and fails this one.
    const userId = await makeUser();
    await seedBalance(userId, 'trusted');
    const signed = await buildSignedPublicCard(userId);
    if (!signed?.attestation) throw new Error('expected an attested card');

    const forged: PublicCard = { ...signed.card, trustTier: 'verified' };
    expect(
      SignatureService.verifySignature(
        canonicalize(forged),
        signed.attestation.signature,
        signed.attestation.publicKey,
      ),
    ).toBe(false);
  });

  it('does not verify against a key that is not the Oxy custodial key', async () => {
    const userId = await makeUser();
    const signed = await buildSignedPublicCard(userId);
    if (!signed?.attestation) throw new Error('expected an attested card');

    const stranger = ec.genKeyPair().getPublic('hex');
    expect(
      SignatureService.verifySignature(
        canonicalize(signed.card),
        signed.attestation.signature,
        stranger,
      ),
    ).toBe(false);
  });

  it('still returns the card, unattested, when the Oxy key is unconfigured', async () => {
    const userId = await makeUser();
    delete process.env.OXY_PRIVATE_KEY;
    delete process.env.OXY_PUBLIC_KEY;
    try {
      const signed = await buildSignedPublicCard(userId);
      if (!signed) throw new Error('expected a card');
      expect(signed.attestation).toBeNull();
      expect(signed.card.userId).toBe(userId);
    } finally {
      process.env.OXY_PRIVATE_KEY = OXY_PRIVATE;
      process.env.OXY_PUBLIC_KEY = OXY_PUBLIC;
    }
  });
});

describe('accounts that must not have a card', () => {
  it('returns null for an id no account holds', async () => {
    expect(await buildSignedPublicCard(uniqueId())).toBeNull();
  });

  it('returns null for an archived account', async () => {
    const userId = await makeUser({ accountStatus: 'archived' });
    expect(await buildSignedPublicCard(userId)).toBeNull();
  });

  it('returns null for a restricted-tier account', async () => {
    const userId = await makeUser({ reputationTier: 'restricted' });
    expect(await buildSignedPublicCard(userId)).toBeNull();
  });
});
