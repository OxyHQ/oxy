/**
 * Chain engine tests — continuity, the verification state machine, and
 * verify-then-append, all driven over STUB stores + resolvers (no DB, no app
 * specifics). These lock the engine behaviour the oxy-api adapter relies on:
 * the same rejection reasons, the same ordering, and the `chain_conflict`
 * backstop surfaced from the store.
 */

import { generateSecp256k1KeyPair } from '../secp256k1';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import {
  checkContinuity,
  verifyEnvelope,
  verifyAndAppend,
  isAuthorizedKey,
  type ChainHead,
  type RecordStore,
  type AppendOutcome,
  type ResolvedVerificationMethods,
  type VerificationMethodResolver,
} from '../index';
import { signEnvelope } from '../envelope/sign';

const keyPair = generateSecp256k1KeyPair();
const PUBLIC_KEY = keyPair.publicKey;
const PRIVATE_KEY = keyPair.privateKey;

const SUBJECT = 'did:web:oxy.so:u:u1';
const CUSTODIAL_ISSUER = 'did:web:oxy.so';
const custodialKeyPair = generateSecp256k1KeyPair();
const CUSTODIAL_PUBLIC_KEY = custodialKeyPair.publicKey;
const CUSTODIAL_PRIVATE_KEY = custodialKeyPair.privateKey;

type V2Fields = Parameters<typeof signEnvelope>[0];

function v2Fields(overrides: Partial<V2Fields> = {}): V2Fields {
  return {
    version: 2,
    type: 'app_record',
    subject: SUBJECT,
    issuer: SUBJECT,
    record: { hello: 'world' },
    issuedAt: 1_700_000_000_000,
    seq: 0,
    prev: null,
    collection: 'app.mention.feed.post',
    rkey: 'r1',
    ...overrides,
  };
}

/** A resolver that authorizes the subject's own key + an optional custodial key. */
function resolver(resolved: ResolvedVerificationMethods | null): VerificationMethodResolver {
  return { resolve: async () => resolved };
}

const SELF_RESOLVED: ResolvedVerificationMethods = {
  currentPublicKeys: [PUBLIC_KEY],
  custodialIssuer: CUSTODIAL_ISSUER,
  custodialPublicKey: CUSTODIAL_PUBLIC_KEY,
};

/** A store stub: no chain, no prior record, append echoes a fixed outcome. */
function stubStore(overrides: Partial<RecordStore> = {}): RecordStore {
  return {
    getHead: async () => null,
    latestIssuedAtForKey: async () => null,
    append: async (_subject, env, recordId): Promise<AppendOutcome> => ({
      ok: true,
      recordId,
      seq: typeof env.seq === 'number' ? env.seq : -1,
    }),
    getLogSince: async () => [],
    resolveCursorSeq: async () => null,
    materializeCurrent: async () => null,
    ...overrides,
  };
}

const FAR_FUTURE_NOW = 1_700_000_000_000 + 1_000;

describe('checkContinuity', () => {
  const head = (headRecordId: string, seq: number): ChainHead => ({ headRecordId, seq, recordCount: seq + 1 });

  it('accepts a v1 record (unchained) regardless of head', async () => {
    const env = await signEnvelope(
      { version: 1, type: 'identity', subject: SUBJECT, issuer: SUBJECT, record: { a: 1 }, issuedAt: 1 },
      PRIVATE_KEY,
    );
    expect(checkContinuity(head('a'.repeat(64), 3), env)).toEqual({ ok: true });
  });

  it('accepts a genesis when there is no head', async () => {
    const env = await signEnvelope(v2Fields(), PRIVATE_KEY);
    expect(checkContinuity(null, env)).toEqual({ ok: true });
  });

  it('rejects a non-genesis with no head as chain_gap', async () => {
    const env = await signEnvelope(v2Fields({ seq: 1, prev: 'a'.repeat(64) }), PRIVATE_KEY);
    expect(checkContinuity(null, env)).toEqual({ ok: false, reason: 'chain_gap' });
  });

  it('rejects a wrong prev as chain_fork', async () => {
    const env = await signEnvelope(v2Fields({ seq: 1, prev: 'b'.repeat(64) }), PRIVATE_KEY);
    expect(checkContinuity(head('a'.repeat(64), 0), env)).toEqual({ ok: false, reason: 'chain_fork' });
  });

  it('rejects a seq gap (correct prev) as bad_seq', async () => {
    const env = await signEnvelope(v2Fields({ seq: 5, prev: 'a'.repeat(64) }), PRIVATE_KEY);
    expect(checkContinuity(head('a'.repeat(64), 0), env)).toEqual({ ok: false, reason: 'bad_seq' });
  });

  it('accepts a correct extension', async () => {
    const env = await signEnvelope(v2Fields({ seq: 1, prev: 'a'.repeat(64) }), PRIVATE_KEY);
    expect(checkContinuity(head('a'.repeat(64), 0), env)).toEqual({ ok: true });
  });
});

describe('isAuthorizedKey', () => {
  it('accepts a self-issued record signed by a current key', async () => {
    const env = await signEnvelope(v2Fields(), PRIVATE_KEY);
    expect(isAuthorizedKey(SELF_RESOLVED, env)).toEqual({ ok: true });
  });

  it('rejects a self-issued record whose key is not a current VM', async () => {
    const env = await signEnvelope(v2Fields(), PRIVATE_KEY);
    expect(isAuthorizedKey({ currentPublicKeys: ['cafe'] }, env)).toEqual({
      ok: false,
      reason: 'public_key_not_a_current_verification_method',
    });
  });

  it('accepts a custodial record signed by the custodial key', async () => {
    const env = await signEnvelope(v2Fields({ issuer: CUSTODIAL_ISSUER }), CUSTODIAL_PRIVATE_KEY);
    expect(isAuthorizedKey(SELF_RESOLVED, env)).toEqual({ ok: true });
  });

  it('rejects a custodial record signed by the wrong key', async () => {
    const env = await signEnvelope(v2Fields({ issuer: CUSTODIAL_ISSUER }), PRIVATE_KEY);
    expect(isAuthorizedKey(SELF_RESOLVED, env)).toEqual({
      ok: false,
      reason: 'public_key_not_a_current_verification_method',
    });
  });

  it('rejects an unknown issuer as untrusted_issuer', async () => {
    const env = await signEnvelope(v2Fields({ issuer: 'did:web:evil.example' }), PRIVATE_KEY);
    expect(isAuthorizedKey(SELF_RESOLVED, env)).toEqual({ ok: false, reason: 'untrusted_issuer' });
  });

  it('rejects when the subject cannot be resolved (null) as untrusted_issuer', async () => {
    const env = await signEnvelope(v2Fields(), PRIVATE_KEY);
    expect(isAuthorizedKey(null, env)).toEqual({ ok: false, reason: 'untrusted_issuer' });
  });
});

describe('verifyEnvelope', () => {
  it('accepts a fresh, well-signed genesis record', async () => {
    const env = await signEnvelope(v2Fields(), PRIVATE_KEY);
    await expect(verifyEnvelope(stubStore(), resolver(SELF_RESOLVED), env, { now: FAR_FUTURE_NOW })).resolves.toEqual({
      ok: true,
    });
  });

  it('rejects a malformed envelope as invalid_envelope', async () => {
    const env = await signEnvelope(v2Fields(), PRIVATE_KEY);
    // v2 envelope missing its required chain `seq` fails the base schema.
    const malformed = { ...env, seq: undefined } as unknown as SignedRecordEnvelope;
    await expect(verifyEnvelope(stubStore(), resolver(SELF_RESOLVED), malformed)).resolves.toEqual({
      ok: false,
      reason: 'invalid_envelope',
    });
  });

  // A v2 envelope MUST carry seq/collection/rkey. The base schema enforces this,
  // and the engine has a defense-in-depth guard (verify.ts) that re-checks them
  // AFTER the signature check. These lock the observable contract: a properly
  // SIGNED v2 envelope with a required chain field stripped is rejected
  // `invalid_envelope` — the engine never appends it on ANY missing field.
  it.each(['seq', 'collection', 'rkey'] as const)(
    'rejects a signed v2 envelope missing `%s` as invalid_envelope',
    async (field) => {
      const env = await signEnvelope(v2Fields(), PRIVATE_KEY);
      // Strip the field AFTER signing, so the envelope's signature is still
      // internally valid — the rejection is purely the missing-chain-field guard.
      const stripped = { ...env };
      delete (stripped as Record<string, unknown>)[field];
      await expect(
        verifyEnvelope(stubStore(), resolver(SELF_RESOLVED), stripped as SignedRecordEnvelope, { now: FAR_FUTURE_NOW }),
      ).resolves.toEqual({ ok: false, reason: 'invalid_envelope' });
    },
  );

  it('rejects a tampered record as bad_signature', async () => {
    const env = await signEnvelope(v2Fields(), PRIVATE_KEY);
    const tampered: SignedRecordEnvelope = { ...env, record: { hello: 'tampered' } };
    await expect(verifyEnvelope(stubStore(), resolver(SELF_RESOLVED), tampered)).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects an unauthorized key as public_key_not_a_current_verification_method', async () => {
    const env = await signEnvelope(v2Fields(), PRIVATE_KEY);
    await expect(
      verifyEnvelope(stubStore(), resolver({ currentPublicKeys: ['cafe'] }), env, { now: FAR_FUTURE_NOW }),
    ).resolves.toEqual({ ok: false, reason: 'public_key_not_a_current_verification_method' });
  });

  it('rejects an untrusted issuer', async () => {
    const env = await signEnvelope(v2Fields({ issuer: 'did:web:evil.example' }), PRIVATE_KEY);
    await expect(
      verifyEnvelope(stubStore(), resolver(SELF_RESOLVED), env, { now: FAR_FUTURE_NOW }),
    ).resolves.toEqual({ ok: false, reason: 'untrusted_issuer' });
  });

  it('rejects an issuedAt too far in the future', async () => {
    const env = await signEnvelope(v2Fields({ issuedAt: 2_000_000_000_000 }), PRIVATE_KEY);
    await expect(
      verifyEnvelope(stubStore(), resolver(SELF_RESOLVED), env, { now: FAR_FUTURE_NOW }),
    ).resolves.toEqual({ ok: false, reason: 'issued_in_future' });
  });

  it('rejects an issuedAt not newer than the latest stored record as stale_issued_at', async () => {
    const env = await signEnvelope(v2Fields({ issuedAt: 1_700_000_000_000 }), PRIVATE_KEY);
    const store = stubStore({ latestIssuedAtForKey: async () => 1_700_000_000_000 });
    await expect(verifyEnvelope(store, resolver(SELF_RESOLVED), env, { now: FAR_FUTURE_NOW })).resolves.toEqual({
      ok: false,
      reason: 'stale_issued_at',
    });
  });

  it('rejects a non-genesis record with no head as chain_gap', async () => {
    const env = await signEnvelope(v2Fields({ seq: 1, prev: 'a'.repeat(64) }), PRIVATE_KEY);
    await expect(
      verifyEnvelope(stubStore(), resolver(SELF_RESOLVED), env, { now: FAR_FUTURE_NOW }),
    ).resolves.toEqual({ ok: false, reason: 'chain_gap' });
  });
});

describe('verifyAndAppend', () => {
  it('verifies then appends, returning the store outcome with the computed recordId', async () => {
    const env = await signEnvelope(v2Fields(), PRIVATE_KEY);
    const append = jest.fn(
      async (_s: string, e: SignedRecordEnvelope, recordId: string): Promise<AppendOutcome> => ({
        ok: true,
        recordId,
        seq: e.seq ?? -1,
      }),
    );
    const store = stubStore({ append });
    const result = await verifyAndAppend(store, resolver(SELF_RESOLVED), env, { now: FAR_FUTURE_NOW });
    expect(result.ok).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
    const [subject, passedEnv, recordId] = append.mock.calls[0];
    expect(subject).toBe(SUBJECT);
    expect(passedEnv).toBe(env);
    expect(recordId).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toEqual({ ok: true, recordId, seq: 0 });
  });

  it('does NOT append when verification fails', async () => {
    const tampered = { ...(await signEnvelope(v2Fields(), PRIVATE_KEY)), record: { x: 'tampered' } };
    const append = jest.fn();
    const store = stubStore({ append });
    const result = await verifyAndAppend(store, resolver(SELF_RESOLVED), tampered, { now: FAR_FUTURE_NOW });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    expect(append).not.toHaveBeenCalled();
  });

  it('surfaces the store chain_conflict backstop', async () => {
    const env = await signEnvelope(v2Fields(), PRIVATE_KEY);
    const store = stubStore({ append: async () => ({ ok: false, reason: 'chain_conflict' }) });
    await expect(verifyAndAppend(store, resolver(SELF_RESOLVED), env, { now: FAR_FUTURE_NOW })).resolves.toEqual({
      ok: false,
      reason: 'chain_conflict',
    });
  });
});
