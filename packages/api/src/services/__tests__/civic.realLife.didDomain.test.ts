/**
 * Real-life attestation under the PRODUCTION did:web anchor — against a REAL
 * Postgres.
 *
 * Production re-anchors server-emitted DIDs at the API host
 * (`DID_WEB_DOMAIN=api.oxy.so`, oxy-infra `app-services.tf`) while the shipped
 * SDK (`@oxyhq/core` `OXY_IDENTITY_APEX`) signs every client envelope at the
 * canonical identity apex (`did:web:oxy.so:u:<accountId>`). The self-issuance
 * gate used to compare DID STRINGS, so every client-signed attestation failed
 * `not_self_issued` in prod — and only in prod, because dev collapses both
 * anchors onto `oxy.so`. The gate is account-based now (`isSelfIssuedByUser` +
 * a dual-anchor `parseUserDid`), and so is the store policy behind it.
 *
 * The suite this replaces mocked the chain store, so it could only observe the
 * gate's verdict. That left the more dangerous half of the same bug untested:
 * `oxyStorePolicy` parses the subject DID a SECOND time, and a spelling it
 * refused would have turned a passing gate into a rejected append. Here the
 * record is really stored and the award really lands, and the row is read back
 * to state the design exactly — the client's spelling is preserved verbatim in
 * `subject_did` while `user_id` resolves to the account, and the server emits
 * its OWN provenance attestation at the API anchor.
 *
 * `DID_WEB_DOMAIN` is a module-load read, so the service chain is loaded FRESH
 * under the prod anchor via `jest.isolateModulesAsync`. That gives the chain its
 * own `config/postgres` instance, which is connected alongside the outer one:
 * two pools, one throwaway database — the fixtures are written through the outer
 * pool and the service reads them through its own.
 */

import { randomUUID } from 'node:crypto';
import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { and, eq } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { signedRecords } from '../../db/schema/signedRecords';
import { users } from '../../db/schema/users';
import { REPUTATION_ATTESTATION_COLLECTION } from '../civic/attestation.service';
import { reputationService } from '../reputation.service';
import { signRecordEnvelope } from '../signedRecord.service';
import {
  REAL_LIFE_ATTESTED_ACTION,
  REAL_LIFE_ATTESTED_POINTS,
} from '../../utils/reputation.constants';

const oxyKey = generateSecp256k1KeyPair();
const OXY_PUBLIC = oxyKey.publicKey;
const OXY_PRIVATE = oxyKey.privateKey;

/** Captured BEFORE `beforeAll` overwrites it, so it can be put back. */
const ORIGINAL_DID_WEB_DOMAIN = process.env.DID_WEB_DOMAIN;

const unique = () => randomUUID();
const ATTESTATION_COLLECTION = 'app.oxy.attestation';

/** The spelling the shipped SDK signs with (`@oxyhq/core` OXY_IDENTITY_APEX). */
const sdkDid = (id: string): string => `did:web:oxy.so:u:${id}`;
/** The spelling the server emits under the prod anchor. */
const serverDid = (id: string): string => `did:web:api.oxy.so:u:${id}`;

interface Signer {
  id: string;
  privateKey: string;
  publicKey: string;
}

async function signer(): Promise<Signer> {
  const keyPair = generateSecp256k1KeyPair();
  const publicKey = keyPair.publicKey;
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${unique().slice(0, 18)}`, publicKey })
    .returning({ id: users.id });
  return { id: row.id, privateKey: keyPair.privateKey, publicKey };
}

async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${unique().slice(0, 18)}` })
    .returning({ id: users.id });
  return row.id;
}

/** B's self-issued attestation about A, spelled however the caller says. */
function attestation(
  attestor: Signer,
  overrides: { subject?: string; issuer?: string; about?: string } = {}
): SignedRecordEnvelope {
  const subject = overrides.subject ?? sdkDid(attestor.id);
  const nonce = `nonce-${unique()}`;
  return signRecordEnvelope(
    {
      version: 2,
      type: 'real_life_attestation',
      subject,
      issuer: overrides.issuer ?? subject,
      record: {
        about: overrides.about ?? '',
        context: 'ctx-1',
        nonce,
        exp: Date.now() + 5 * 60 * 1000,
      },
      issuedAt: Date.now(),
      seq: 0,
      prev: null,
      collection: ATTESTATION_COLLECTION,
      rkey: nonce,
      publicKey: attestor.publicKey,
      alg: 'ES256K-DER-SHA256',
    },
    attestor.privateKey
  );
}

async function awards(subjectUserId: string) {
  return getDb()
    .select({
      id: reputationTransactions.id,
      points: reputationTransactions.points,
      createdByUserId: reputationTransactions.createdByUserId,
    })
    .from(reputationTransactions)
    .where(
      and(
        eq(reputationTransactions.userId, subjectUserId),
        eq(reputationTransactions.actionType, REAL_LIFE_ATTESTED_ACTION)
      )
    );
}

let submit: typeof import('../civic/realLife.service.js').submitRealLifeAttestation;
let closeServiceChain: () => Promise<void>;

beforeAll(async () => {
  process.env.DID_WEB_DOMAIN = 'api.oxy.so';
  process.env.OXY_PRIVATE_KEY = OXY_PRIVATE;
  process.env.OXY_PUBLIC_KEY = OXY_PUBLIC;

  await jest.isolateModulesAsync(async () => {
    // The isolated registry brings its own `config/postgres`, so the service
    // chain needs its own connection to the same throwaway database.
    const postgres = await import('../../config/postgres.js');
    await postgres.connectPostgres();
    closeServiceChain = postgres.closePostgres;
    ({ submitRealLifeAttestation: submit } = await import('../civic/realLife.service.js'));
  });

  await connectPostgres();
  await reputationService.seedDefaultRules();
});

afterAll(async () => {
  if (ORIGINAL_DID_WEB_DOMAIN === undefined) {
    delete process.env.DID_WEB_DOMAIN;
  } else {
    process.env.DID_WEB_DOMAIN = ORIGINAL_DID_WEB_DOMAIN;
  }
  delete process.env.OXY_PRIVATE_KEY;
  delete process.env.OXY_PUBLIC_KEY;
  await closeServiceChain();
  await closePostgres();
});

describe('both anchors name the same account', () => {
  it('accepts an SDK-spelled envelope and stores it verbatim against the resolved account', async () => {
    const subject = await account();
    const attestor = await signer();

    const result = await submit(
      attestation(attestor, { about: sdkDid(subject) }),
      attestor.id
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({
      subjectUserId: subject,
      attestorUserId: attestor.id,
      points: REAL_LIFE_ATTESTED_POINTS,
    });

    // The store policy re-parses the subject DID, so a spelling the gate let
    // through could still be refused here. It was not: the row exists, keyed to
    // the ACCOUNT while preserving the CLIENT's spelling.
    const [stored] = await getDb()
      .select({ subjectDid: signedRecords.subjectDid, recordId: signedRecords.recordId })
      .from(signedRecords)
      .where(
        and(
          eq(signedRecords.userId, attestor.id),
          eq(signedRecords.nsid, ATTESTATION_COLLECTION)
        )
      );
    expect(stored).toBeDefined();
    expect(stored.subjectDid).toBe(sdkDid(attestor.id));
    expect(stored.recordId).toBe(result.recordId);

    expect(await awards(subject)).toEqual([
      { id: expect.any(String), points: REAL_LIFE_ATTESTED_POINTS, createdByUserId: attestor.id },
    ]);
  });

  it('accepts a server-spelled envelope too', async () => {
    const subject = await account();
    const attestor = await signer();

    const result = await submit(
      attestation(attestor, { subject: serverDid(attestor.id), about: serverDid(subject) }),
      attestor.id
    );

    expect(result.ok).toBe(true);
    expect(await awards(subject)).toHaveLength(1);
  });

  it('accepts an envelope that MIXES the two spellings', async () => {
    // A real client can hold a cached DID from one anchor and a freshly scanned
    // QR from the other. Both segments resolve independently, so the mix has to
    // work or the flow breaks on exactly the days an anchor changes.
    const subject = await account();
    const attestor = await signer();

    const result = await submit(
      attestation(attestor, { subject: sdkDid(attestor.id), about: serverDid(subject) }),
      attestor.id
    );

    expect(result.ok).toBe(true);
    expect(await awards(subject)).toHaveLength(1);
  });

  it('emits the Oxy provenance attestation at the SERVER anchor', async () => {
    // The server accepts either spelling on the way in and emits its own on the
    // way out — that asymmetry is the design, not an accident, so it is stated.
    const subject = await account();
    const attestor = await signer();
    await submit(attestation(attestor, { about: sdkDid(subject) }), attestor.id);

    const [provenance] = await getDb()
      .select({ subjectDid: signedRecords.subjectDid, envelope: signedRecords.envelope })
      .from(signedRecords)
      .where(
        and(
          eq(signedRecords.userId, subject),
          eq(signedRecords.nsid, REPUTATION_ATTESTATION_COLLECTION)
        )
      );
    expect(provenance).toBeDefined();
    expect(provenance.subjectDid).toBe(serverDid(subject));
    expect(provenance.envelope.issuer).toBe('did:web:api.oxy.so');
  });
});

describe('the gate is still a gate', () => {
  it('rejects an envelope self-issued as a DIFFERENT account, in either spelling', async () => {
    const subject = await account();
    const attestor = await signer();

    expect(
      await submit(
        attestation(attestor, { subject: sdkDid(subject), about: sdkDid(subject) }),
        attestor.id
      )
    ).toEqual({ ok: false, reason: 'not_self_issued' });
    expect(
      await submit(
        attestation(attestor, { subject: serverDid(subject), about: serverDid(subject) }),
        attestor.id
      )
    ).toEqual({ ok: false, reason: 'not_self_issued' });

    expect(await awards(subject)).toEqual([]);
  });

  it('rejects a subject DID at a foreign domain', async () => {
    const subject = await account();
    const attestor = await signer();
    const foreign = `did:web:evil.com:u:${attestor.id}`;

    expect(
      await submit(attestation(attestor, { subject: foreign, about: sdkDid(subject) }), attestor.id)
    ).toEqual({ ok: false, reason: 'not_self_issued' });
    expect(await awards(subject)).toEqual([]);
  });

  it('rejects an envelope whose issuer and subject are different identities', async () => {
    const subject = await account();
    const attestor = await signer();

    expect(
      await submit(
        attestation(attestor, { issuer: sdkDid(subject), about: sdkDid(subject) }),
        attestor.id
      )
    ).toEqual({ ok: false, reason: 'not_self_issued' });
  });

  it('rejects an `about` at a foreign domain even when the envelope is self-issued', async () => {
    const attestor = await signer();

    expect(
      await submit(
        attestation(attestor, { about: `did:web:evil.com:u:${unique()}` }),
        attestor.id
      )
    ).toEqual({ ok: false, reason: 'invalid_subject' });
  });
});
