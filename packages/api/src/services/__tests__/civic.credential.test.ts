/**
 * Verifiable credentials (civic / Fase 4), against a REAL Postgres.
 *
 * The suite this replaces mocked `VerifiableCredential`, `SignedRecord`,
 * `RepoHead` and `User` as Mongoose models the service no longer imports, and
 * fed `verifyCredential` a hand-written `{ envelope }` object — so the "stored
 * envelope" it verified was one the test had just built in memory, never one the
 * ledger held. That is the single most important thing about a credential:
 *
 *  - **Verification recomputes the canonical signing input from the STORED
 *    envelope**, never from the projection's denormalized claims. The tampered
 *    case below therefore alters the LEDGER row and leaves the projection
 *    pristine, which is the shape a suite reading its own fixture cannot
 *    reproduce.
 *  - **The proof must verify against a CURRENT verification method of the
 *    issuer.** The rotation case moves `users.public_key` after issuance, so a
 *    credential signed with a retired key stops verifying — the property that
 *    makes revocation-by-key-rotation meaningful.
 *  - **`verifiable_credentials.record_id` is a real foreign key** onto
 *    `signed_records.record_id`, and a v1 (unchained) envelope stores no content
 *    address at all. That is why the store policy refuses one for this type; it
 *    is asserted here rather than assumed.
 *  - **`status` and `revoked_at` are one fact.** The table's CHECK makes a
 *    revocation date on an active credential unrepresentable, so the revoke case
 *    reads both columns back.
 *
 * The two issuance modes put the signed record on DIFFERENT chains — user-issued
 * on the ISSUER's, org-issued custodially on the HOLDER's — and each case asserts
 * which chain actually received it.
 *
 * The whole run shares one database, so every account and every credential
 * carries a per-test random id and no assertion depends on a table being empty.
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { signedRecords } from '../../db/schema/signedRecords';
import { users } from '../../db/schema/users';
import { verifiableCredentials } from '../../db/schema/verifiableCredentials';
import {
  issueCredential,
  issueOrgCredential,
  listCredentialsForHolder,
  revokeCredential,
  verifyCredential,
} from '../civic/credential.service';
import { signRecordEnvelope } from '../signedRecord.service';
import { buildUserDid, OXY_DID } from '../did.service';
import { CREDENTIAL_BASE_TYPE, CREDENTIAL_COLLECTION } from '../../utils/civic.constants';

const oxyKey = generateSecp256k1KeyPair();
const OXY_PUBLIC = oxyKey.publicKey;
const OXY_PRIVATE = oxyKey.privateKey;

const uniqueId = () => randomUUID().replace(/-/g, '');

interface Signer {
  userId: string;
  did: string;
  publicKey: string;
  privateKey: string;
}

async function makeSigner(): Promise<Signer> {
  const keyPair = generateSecp256k1KeyPair();
  const publicKey = keyPair.publicKey;
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({ id, username: `c${id.slice(0, 12)}`, publicKey });
  return { userId: id, did: buildUserDid(id), publicKey, privateKey: keyPair.privateKey };
}

async function makeHolder(): Promise<string> {
  const id = uniqueId();
  await getDb().insert(users).values({ id, username: `h${id.slice(0, 12)}` });
  return id;
}

interface EnvelopeOverrides {
  type?: SignedRecordEnvelope['type'];
  subject?: string;
  issuer?: string;
  about?: string;
  types?: string[];
  claims?: Record<string, unknown>;
  expiresAt?: number;
  issuedAt?: number;
  rkey?: string;
  seq?: number;
  prev?: string | null;
  version?: 1 | 2;
  privateKey?: string;
  publicKey?: string;
}

/** Build + REAL-sign a self-issued v2 `credential` envelope from `issuer`. */
function credentialEnvelope(issuer: Signer, overrides: EnvelopeOverrides = {}): SignedRecordEnvelope {
  const record: Record<string, unknown> = {
    about: overrides.about ?? buildUserDid(uniqueId()),
    types: overrides.types ?? [CREDENTIAL_BASE_TYPE, 'EmploymentCredential'],
    claims: overrides.claims ?? { employer: 'Acme', from: '2020', to: '2024' },
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
  };
  const chained =
    overrides.version === 1
      ? {}
      : {
          seq: overrides.seq ?? 0,
          prev: overrides.prev ?? null,
          collection: CREDENTIAL_COLLECTION,
          rkey: overrides.rkey ?? `cred-${uniqueId().slice(0, 8)}`,
        };
  return signRecordEnvelope(
    {
      version: overrides.version ?? 2,
      type: overrides.type ?? 'credential',
      subject: overrides.subject ?? issuer.did,
      issuer: overrides.issuer ?? issuer.did,
      record,
      issuedAt: overrides.issuedAt ?? Date.now(),
      ...chained,
      publicKey: overrides.publicKey ?? issuer.publicKey,
      alg: 'ES256K-DER-SHA256',
    } as Omit<SignedRecordEnvelope, 'signature'>,
    overrides.privateKey ?? issuer.privateKey,
  );
}

async function credentialRows(holderUserId: string) {
  return getDb()
    .select()
    .from(verifiableCredentials)
    .where(eq(verifiableCredentials.holderUserId, holderUserId));
}

async function chainRows(userId: string) {
  return getDb()
    .select({ recordId: signedRecords.recordId, type: signedRecords.type })
    .from(signedRecords)
    .where(eq(signedRecords.userId, userId));
}

/**
 * Plant a signed record + its credential projection DIRECTLY, so a ledger state
 * the service will not produce can still be verified against. Used for the two
 * corruption cases (a tampered envelope, an issuer whose account is gone), which
 * are exactly what `verifyCredential` exists to catch.
 */
async function plantCredential(options: {
  chainUserId: string;
  holderUserId: string;
  envelope: SignedRecordEnvelope;
}): Promise<{ recordId: string; credentialId: string }> {
  const recordId = createHash('sha256').update(uniqueId()).digest('hex');
  await getDb().insert(signedRecords).values({
    subjectDid: options.envelope.subject,
    userId: options.chainUserId,
    type: 'credential',
    envelope: options.envelope,
    publicKey: options.envelope.publicKey,
    verified: true,
    seq: 0,
    prev: null,
    recordId,
    nsid: CREDENTIAL_COLLECTION,
    rkey: `planted-${uniqueId().slice(0, 8)}`,
  });
  const [credential] = await getDb()
    .insert(verifiableCredentials)
    .values({
      holderUserId: options.holderUserId,
      holderDid: buildUserDid(options.holderUserId),
      issuerDid: options.envelope.issuer,
      types: [CREDENTIAL_BASE_TYPE, 'EmploymentCredential'],
      claims: { employer: 'Acme' },
      recordId,
      issuedAt: new Date(options.envelope.issuedAt),
    })
    .returning({ id: verifiableCredentials.id });
  return { recordId, credentialId: credential.id };
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

describe('issueCredential — what a user-signed credential writes', () => {
  it('appends the proof to the ISSUER’s chain and projects the queryable row', async () => {
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    const claims = { employer: `Acme-${uniqueId().slice(0, 6)}`, from: '2020' };

    const result = await issueCredential(
      credentialEnvelope(issuer, { about: buildUserDid(holderUserId), claims }),
      issuer.userId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential).toMatchObject({
      holderUserId,
      holderDid: buildUserDid(holderUserId),
      issuerUserId: issuer.userId,
      issuerDid: issuer.did,
      types: [CREDENTIAL_BASE_TYPE, 'EmploymentCredential'],
      claims,
      status: 'active',
    });

    const rows = await credentialRows(holderUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recordId: result.credential.recordId,
      issuerUserId: issuer.userId,
      status: 'active',
      revokedAt: null,
      expiresAt: null,
    });
    expect(rows[0].claims).toEqual(claims);

    // The proof lives on the ISSUER's chain; the holder signed nothing.
    expect(await chainRows(issuer.userId)).toEqual([
      { recordId: result.credential.recordId, type: 'credential' },
    ]);
    expect(await chainRows(holderUserId)).toEqual([]);
  });

  it('stores a future expiry from the SIGNED bytes', async () => {
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    const expiresAt = Date.now() + 86_400_000;

    const result = await issueCredential(
      credentialEnvelope(issuer, { about: buildUserDid(holderUserId), expiresAt }),
      issuer.userId,
    );
    expect(result.ok).toBe(true);

    const [row] = await credentialRows(holderUserId);
    expect(row.expiresAt?.getTime()).toBe(expiresAt);
  });
});

describe('issueCredential — a refusal writes nothing', () => {
  async function expectNothingWritten(issuerUserId: string, holderUserId: string): Promise<void> {
    expect(await credentialRows(holderUserId)).toEqual([]);
    expect(await chainRows(issuerUserId)).toEqual([]);
  }

  it('refuses an envelope of the wrong type', async () => {
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    expect(
      await issueCredential(
        credentialEnvelope(issuer, { about: buildUserDid(holderUserId), type: 'identity' }),
        issuer.userId,
      ),
    ).toEqual({ ok: false, reason: 'invalid_type' });
    await expectNothingWritten(issuer.userId, holderUserId);
  });

  it('refuses an envelope the caller did not self-issue', async () => {
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    expect(
      await issueCredential(
        credentialEnvelope(issuer, {
          about: buildUserDid(holderUserId),
          subject: buildUserDid(holderUserId),
          issuer: buildUserDid(holderUserId),
        }),
        issuer.userId,
      ),
    ).toEqual({ ok: false, reason: 'not_self_issued' });
    await expectNothingWritten(issuer.userId, holderUserId);
  });

  it('refuses a record with no `types`', async () => {
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    expect(
      await issueCredential(
        credentialEnvelope(issuer, { about: buildUserDid(holderUserId), types: [] }),
        issuer.userId,
      ),
    ).toEqual({ ok: false, reason: 'invalid_record' });
    await expectNothingWritten(issuer.userId, holderUserId);
  });

  it('refuses a credential missing the W3C base type', async () => {
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    expect(
      await issueCredential(
        credentialEnvelope(issuer, {
          about: buildUserDid(holderUserId),
          types: ['EmploymentCredential'],
        }),
        issuer.userId,
      ),
    ).toEqual({ ok: false, reason: 'missing_base_type' });
    await expectNothingWritten(issuer.userId, holderUserId);
  });

  it('refuses a holder reference that is not a user DID', async () => {
    const issuer = await makeSigner();
    expect(
      await issueCredential(credentialEnvelope(issuer, { about: 'not-a-did' }), issuer.userId),
    ).toEqual({ ok: false, reason: 'invalid_holder' });
    expect(await chainRows(issuer.userId)).toEqual([]);
  });

  it('refuses a credential the issuer wrote about themselves', async () => {
    const issuer = await makeSigner();
    expect(
      await issueCredential(credentialEnvelope(issuer, { about: issuer.did }), issuer.userId),
    ).toEqual({ ok: false, reason: 'self_credential' });
    await expectNothingWritten(issuer.userId, issuer.userId);
  });

  it('refuses an expiry that is already past', async () => {
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    expect(
      await issueCredential(
        credentialEnvelope(issuer, {
          about: buildUserDid(holderUserId),
          expiresAt: Date.now() - 1_000,
        }),
        issuer.userId,
      ),
    ).toEqual({ ok: false, reason: 'invalid_expiry' });
    await expectNothingWritten(issuer.userId, holderUserId);
  });

  it('refuses a credential about an account that does not exist', async () => {
    const issuer = await makeSigner();
    expect(
      await issueCredential(
        credentialEnvelope(issuer, { about: buildUserDid(uniqueId()) }),
        issuer.userId,
      ),
    ).toEqual({ ok: false, reason: 'holder_not_found' });
    expect(await chainRows(issuer.userId)).toEqual([]);
  });

  it('refuses a TAMPERED envelope BEFORE it reaches the chain', async () => {
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    const signed = credentialEnvelope(issuer, { about: buildUserDid(holderUserId) });
    const tampered: SignedRecordEnvelope = {
      ...signed,
      record: { ...(signed.record as Record<string, unknown>), claims: { employer: 'Mallory' } },
    };

    expect(await issueCredential(tampered, issuer.userId)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    await expectNothingWritten(issuer.userId, holderUserId);
  });

  it('refuses a v1 (UNCHAINED) envelope — its address would name no stored row', async () => {
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    expect(
      await issueCredential(
        credentialEnvelope(issuer, { about: buildUserDid(holderUserId), version: 1 }),
        issuer.userId,
      ),
    ).toEqual({ ok: false, reason: 'invalid_envelope' });
    await expectNothingWritten(issuer.userId, holderUserId);
  });
});

describe('verifyCredential — the STORED envelope is the source of truth', () => {
  /** Issue a real credential and hand back both lookup handles. */
  async function issued(): Promise<{ issuer: Signer; holderUserId: string; recordId: string; id: string }> {
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    const result = await issueCredential(
      credentialEnvelope(issuer, { about: buildUserDid(holderUserId) }),
      issuer.userId,
    );
    if (!result.ok) {
      throw new Error(`credential fixture could not be issued: ${result.reason}`);
    }
    return { issuer, holderUserId, recordId: result.credential.recordId, id: result.credential.id };
  }

  it('passes by content address AND by row id', async () => {
    const { recordId, id } = await issued();

    const byRecord = await verifyCredential(recordId);
    expect(byRecord.valid).toBe(true);
    expect(byRecord.reason).toBeUndefined();
    expect(byRecord.credential?.recordId).toBe(recordId);

    const byId = await verifyCredential(id);
    expect(byId.valid).toBe(true);
    expect(byId.credential?.id).toBe(id);
  });

  it('FAILS once the issuer has rotated the signing key away', async () => {
    const { issuer, recordId } = await issued();
    await getDb()
      .update(users)
      .set({ publicKey: generateSecp256k1KeyPair().publicKey })
      .where(eq(users.id, issuer.userId));

    // The credential is untouched; only the issuer's CURRENT verification
    // methods changed — which is what makes key rotation a real revocation.
    expect(await verifyCredential(recordId)).toMatchObject({
      valid: false,
      reason: 'issuer_key_not_current',
    });
  });

  it('FAILS when the LEDGER’s envelope no longer matches its signature', async () => {
    // The projection is left pristine on purpose: a verifier reading the
    // denormalized claims instead of the stored envelope passes this.
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    const signed = credentialEnvelope(issuer, { about: buildUserDid(holderUserId) });
    const { recordId } = await plantCredential({
      chainUserId: issuer.userId,
      holderUserId,
      envelope: {
        ...signed,
        record: { ...(signed.record as Record<string, unknown>), claims: { employer: 'Mallory' } },
      },
    });

    expect(await verifyCredential(recordId)).toMatchObject({
      valid: false,
      reason: 'bad_signature',
    });
  });

  it('FAILS when the issuer DID resolves to no account at all', async () => {
    const chainOwner = await makeSigner();
    const holderUserId = await makeHolder();
    const ghost = generateSecp256k1KeyPair();
    const ghostDid = buildUserDid(uniqueId());
    const envelope = signRecordEnvelope(
      {
        version: 2,
        type: 'credential',
        subject: ghostDid,
        issuer: ghostDid,
        record: {
          about: buildUserDid(holderUserId),
          types: [CREDENTIAL_BASE_TYPE, 'EmploymentCredential'],
          claims: { employer: 'Acme' },
        },
        issuedAt: Date.now(),
        seq: 0,
        prev: null,
        collection: CREDENTIAL_COLLECTION,
        rkey: 'ghost',
        publicKey: ghost.publicKey,
        alg: 'ES256K-DER-SHA256',
      },
      ghost.privateKey,
    );
    const { recordId } = await plantCredential({
      chainUserId: chainOwner.userId,
      holderUserId,
      envelope,
    });

    expect(await verifyCredential(recordId)).toMatchObject({
      valid: false,
      reason: 'issuer_not_found',
    });
  });

  it('FAILS a revoked credential', async () => {
    const { issuer, recordId, id } = await issued();
    expect((await revokeCredential(id, issuer.userId)).ok).toBe(true);

    expect(await verifyCredential(recordId)).toMatchObject({ valid: false, reason: 'revoked' });
  });

  it('FAILS an expired credential and lazily flips the STORED status', async () => {
    // Issued in the past with an expiry that has since elapsed. The table's
    // `expires_at > issued_at` CHECK means an expiry cannot simply be back-dated
    // past the issuance — a dead credential is one whose window has CLOSED, not
    // one that never opened.
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    const issuedAt = Date.now() - 60_000;
    const fixture = await issueCredential(
      credentialEnvelope(issuer, { about: buildUserDid(holderUserId), issuedAt }),
      issuer.userId,
    );
    if (!fixture.ok) throw new Error(`fixture failed: ${fixture.reason}`);
    const recordId = fixture.credential.recordId;
    await getDb()
      .update(verifiableCredentials)
      .set({ expiresAt: new Date(issuedAt + 30_000) })
      .where(eq(verifiableCredentials.recordId, recordId));

    const result = await verifyCredential(recordId);
    expect(result).toMatchObject({ valid: false, reason: 'expired' });
    expect(result.credential?.status).toBe('expired');
    // The lazy flip is a WRITE — asserted against the row, not the verdict.
    const [row] = await credentialRows(holderUserId);
    expect(row.status).toBe('expired');
  });

  it('reports not_found for an address no credential holds', async () => {
    expect(await verifyCredential(uniqueId())).toEqual({
      valid: false,
      reason: 'not_found',
      credential: null,
    });
  });
});

describe('revokeCredential', () => {
  async function issued(): Promise<{ issuer: Signer; holderUserId: string; id: string }> {
    const issuer = await makeSigner();
    const holderUserId = await makeHolder();
    const result = await issueCredential(
      credentialEnvelope(issuer, { about: buildUserDid(holderUserId) }),
      issuer.userId,
    );
    if (!result.ok) {
      throw new Error(`credential fixture could not be issued: ${result.reason}`);
    }
    return { issuer, holderUserId, id: result.credential.id };
  }

  it('lets the ORIGINAL issuer revoke, moving status and revokedAt together', async () => {
    const { issuer, holderUserId, id } = await issued();

    const result = await revokeCredential(id, issuer.userId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.status).toBe('revoked');
    expect(result.credential.revokedAt).toBeDefined();

    // The table's CHECK ties the two together; the row is what proves it.
    const [row] = await credentialRows(holderUserId);
    expect(row.status).toBe('revoked');
    expect(row.revokedAt).toBeInstanceOf(Date);
  });

  it('refuses anyone who is not the issuer, and changes nothing', async () => {
    const { holderUserId, id } = await issued();
    const stranger = await makeSigner();

    expect(await revokeCredential(id, stranger.userId)).toEqual({
      ok: false,
      reason: 'not_issuer',
    });
    const [row] = await credentialRows(holderUserId);
    expect(row.status).toBe('active');
    expect(row.revokedAt).toBeNull();
  });

  it('refuses the HOLDER — a credential is the issuer’s statement', async () => {
    const { holderUserId, id } = await issued();
    expect(await revokeCredential(id, holderUserId)).toEqual({ ok: false, reason: 'not_issuer' });
  });

  it('refuses a second revocation', async () => {
    const { issuer, id } = await issued();
    expect((await revokeCredential(id, issuer.userId)).ok).toBe(true);
    expect(await revokeCredential(id, issuer.userId)).toEqual({
      ok: false,
      reason: 'already_revoked',
    });
  });

  it('reports not_found for an id no credential holds', async () => {
    const issuer = await makeSigner();
    expect(await revokeCredential(uniqueId(), issuer.userId)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('listCredentialsForHolder', () => {
  it('returns the holder’s credentials newest first, and nobody else’s', async () => {
    const holderUserId = await makeHolder();
    const otherHolderId = await makeHolder();
    const issuer = await makeSigner();
    const now = Date.now();

    // Three credentials from one issuer — a chain, so each carries the previous
    // record's address as `prev`.
    const issuedAts = [now - 30_000, now - 20_000, now - 10_000];
    let prev: string | null = null;
    const recordIds: string[] = [];
    for (const [index, issuedAt] of issuedAts.entries()) {
      const result = await issueCredential(
        credentialEnvelope(issuer, {
          about: buildUserDid(holderUserId),
          issuedAt,
          seq: index,
          prev,
        }),
        issuer.userId,
      );
      if (!result.ok) throw new Error(`fixture failed: ${result.reason}`);
      prev = result.credential.recordId;
      recordIds.push(result.credential.recordId);
    }

    const otherIssuer = await makeSigner();
    await issueCredential(
      credentialEnvelope(otherIssuer, { about: buildUserDid(otherHolderId) }),
      otherIssuer.userId,
    );

    const list = await listCredentialsForHolder(holderUserId);

    expect(list.map((credential) => credential.recordId)).toEqual([...recordIds].reverse());
    expect(list.every((credential) => credential.holderUserId === holderUserId)).toBe(true);
  });

  it('filters on the stored status', async () => {
    const holderUserId = await makeHolder();
    const issuer = await makeSigner();
    const first = await issueCredential(
      credentialEnvelope(issuer, { about: buildUserDid(holderUserId), seq: 0 }),
      issuer.userId,
    );
    if (!first.ok) throw new Error(`fixture failed: ${first.reason}`);
    const second = await issueCredential(
      credentialEnvelope(issuer, {
        about: buildUserDid(holderUserId),
        seq: 1,
        prev: first.credential.recordId,
      }),
      issuer.userId,
    );
    if (!second.ok) throw new Error(`fixture failed: ${second.reason}`);
    await revokeCredential(second.credential.id, issuer.userId);

    expect(
      (await listCredentialsForHolder(holderUserId, { status: 'revoked' })).map((c) => c.recordId),
    ).toEqual([second.credential.recordId]);
    expect(
      (await listCredentialsForHolder(holderUserId, { status: 'active' })).map((c) => c.recordId),
    ).toEqual([first.credential.recordId]);
  });

  it('is empty for a holder nobody has credentialed', async () => {
    expect(await listCredentialsForHolder(await makeHolder())).toEqual([]);
  });
});

describe('issueOrgCredential — the Oxy custodial seam', () => {
  it('mints onto the HOLDER’s chain with no issuing account, and verifies', async () => {
    const holderUserId = await makeHolder();

    const result = await issueOrgCredential({
      holderDid: buildUserDid(holderUserId),
      types: [CREDENTIAL_BASE_TYPE, 'CourseCredential'],
      claims: { course: 'Civics 101' },
      rkey: `org-${uniqueId().slice(0, 8)}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.issuerDid).toBe(OXY_DID);
    expect(result.credential.issuerUserId).toBeUndefined();

    // The asymmetry that matters: a custodial credential lands on the HOLDER's
    // chain, not on any issuer's.
    expect(await chainRows(holderUserId)).toEqual([
      { recordId: result.credential.recordId, type: 'credential' },
    ]);

    const [row] = await credentialRows(holderUserId);
    expect(row.issuerUserId).toBeNull();
    expect(row.issuerDid).toBe(OXY_DID);

    // …and it verifies against the Oxy organisation DID's custodial key.
    expect(await verifyCredential(result.credential.recordId)).toMatchObject({ valid: true });
  });

  it('records the application it was minted on behalf of', async () => {
    const holderUserId = await makeHolder();
    const applicationId = uniqueId();

    const result = await issueOrgCredential({
      holderDid: buildUserDid(holderUserId),
      types: [CREDENTIAL_BASE_TYPE, 'CourseCredential'],
      claims: { course: 'Civics 101' },
      rkey: `org-${uniqueId().slice(0, 8)}`,
      onBehalfOfApplicationId: applicationId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.claims).toEqual({ course: 'Civics 101', onBehalfOf: applicationId });
  });

  it('is NOT revocable through the user path — it has no issuing account', async () => {
    const holderUserId = await makeHolder();
    const result = await issueOrgCredential({
      holderDid: buildUserDid(holderUserId),
      types: [CREDENTIAL_BASE_TYPE, 'CourseCredential'],
      claims: {},
      rkey: `org-${uniqueId().slice(0, 8)}`,
    });
    if (!result.ok) throw new Error(`fixture failed: ${result.reason}`);

    expect(await revokeCredential(result.credential.id, holderUserId)).toEqual({
      ok: false,
      reason: 'not_issuer',
    });
  });

  it('refuses to mint without the base type, a real holder, or a live expiry', async () => {
    const holderUserId = await makeHolder();
    const base = {
      holderDid: buildUserDid(holderUserId),
      types: [CREDENTIAL_BASE_TYPE, 'CourseCredential'],
      claims: {},
    };

    expect(
      await issueOrgCredential({ ...base, types: ['CourseCredential'], rkey: uniqueId() }),
    ).toEqual({ ok: false, reason: 'missing_base_type' });
    expect(await issueOrgCredential({ ...base, holderDid: 'not-a-did', rkey: uniqueId() })).toEqual(
      { ok: false, reason: 'invalid_holder' },
    );
    expect(
      await issueOrgCredential({
        ...base,
        holderDid: buildUserDid(uniqueId()),
        rkey: uniqueId(),
      }),
    ).toEqual({ ok: false, reason: 'holder_not_found' });
    expect(
      await issueOrgCredential({ ...base, expiresAt: Date.now() - 1_000, rkey: uniqueId() }),
    ).toEqual({ ok: false, reason: 'invalid_expiry' });

    expect(await credentialRows(holderUserId)).toEqual([]);
    expect(await chainRows(holderUserId)).toEqual([]);
  });

  it('skips entirely when the Oxy custodial key is unconfigured', async () => {
    const holderUserId = await makeHolder();
    delete process.env.OXY_PRIVATE_KEY;
    delete process.env.OXY_PUBLIC_KEY;
    try {
      expect(
        await issueOrgCredential({
          holderDid: buildUserDid(holderUserId),
          types: [CREDENTIAL_BASE_TYPE, 'CourseCredential'],
          claims: {},
          rkey: `org-${uniqueId().slice(0, 8)}`,
        }),
      ).toEqual({ ok: false, reason: 'oxy_key_unconfigured' });
      expect(await chainRows(holderUserId)).toEqual([]);
    } finally {
      process.env.OXY_PRIVATE_KEY = OXY_PRIVATE;
      process.env.OXY_PUBLIC_KEY = OXY_PUBLIC;
    }
  });
});
