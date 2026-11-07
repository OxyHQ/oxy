/**
 * The Oxy Keychain's request contract (ADR 0063, `docs/identity/keychain.md`):
 * strict objects, binary values in their one canonical base64url spelling and
 * length, roster bodies that are exactly one of the five shapes and that the
 * parse never rewrites (the server compares a body to the JCS of its parse).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  IDENTITY_PROOF_ACTIONS,
  KEYCHAIN_LIMITS,
  REAUTH_ACTIONS,
  keychainBytes32Schema,
  keychainCiphertextSchema,
  keychainCreateRequestSchema,
  keychainEntrySchema,
  keychainItemPutRequestSchema,
  keychainItemsQuerySchema,
  keychainMemberSchema,
  keychainNonceSchema,
  keychainResetRequestSchema,
  keychainRosterBodySchema,
  keychainSignatureValueSchema,
} from '../index';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const key = () => b64(randomBytes(32));

const member = () => ({
  id: randomUUID(),
  name: 'ThinkPad',
  platform: 'oxyos',
  signingKey: key(),
  boxKey: key(),
});

const base = () => ({
  v: 1,
  vaultId: randomUUID(),
  seq: 1,
  prev: 'a'.repeat(64),
  createdAt: '2026-11-07T12:00:00.000Z',
});

describe('binary values', () => {
  it('accepts exactly 32 bytes as canonical base64url', () => {
    for (let index = 0; index < 50; index++) {
      expect(keychainBytes32Schema.safeParse(key()).success).toBe(true);
    }
    expect(keychainBytes32Schema.safeParse(b64(randomBytes(31))).success).toBe(false);
    expect(keychainBytes32Schema.safeParse(b64(randomBytes(33))).success).toBe(false);
    // Padding, the standard alphabet, and a last character with stray low bits.
    expect(keychainBytes32Schema.safeParse(`${key()}=`).success).toBe(false);
    expect(keychainBytes32Schema.safeParse(`${'A'.repeat(42)}+`).success).toBe(false);
    expect(keychainBytes32Schema.safeParse(`${'A'.repeat(42)}B`).success).toBe(false);
  });

  it('accepts a 24-byte nonce, a 64-byte signature and a bounded ciphertext', () => {
    expect(keychainNonceSchema.safeParse(b64(randomBytes(24))).success).toBe(true);
    expect(keychainNonceSchema.safeParse(b64(randomBytes(12))).success).toBe(false);
    expect(keychainSignatureValueSchema.safeParse(b64(randomBytes(64))).success).toBe(true);
    expect(keychainSignatureValueSchema.safeParse(`${'A'.repeat(85)}B`).success).toBe(false);
    expect(keychainCiphertextSchema.safeParse(b64(randomBytes(272))).success).toBe(true);
    expect(keychainCiphertextSchema.safeParse(b64(randomBytes(4))).success).toBe(false);
    expect(
      keychainCiphertextSchema.safeParse('A'.repeat(KEYCHAIN_LIMITS.maxCiphertextLength + 4))
        .success,
    ).toBe(false);
    // A length no byte count encodes to.
    expect(keychainCiphertextSchema.safeParse('A'.repeat(29)).success).toBe(false);
  });
});

describe('members', () => {
  it('is strict, with a plain name and a closed platform', () => {
    expect(keychainMemberSchema.safeParse(member()).success).toBe(true);
    expect(keychainMemberSchema.safeParse({ ...member(), extra: 1 }).success).toBe(false);
    expect(keychainMemberSchema.safeParse({ ...member(), platform: 'plan9' }).success).toBe(false);
    expect(
      keychainMemberSchema.safeParse({ ...member(), id: randomUUID().toUpperCase() }).success,
    ).toBe(false);
    for (const name of [
      '',
      ' Laptop',
      'Laptop ',
      'a\u0000b',
      'a\u0085b',
      '\ud800x',
      'x\udc00',
      'n'.repeat(65),
    ]) {
      expect(keychainMemberSchema.safeParse({ ...member(), name }).success).toBe(false);
    }
    expect(keychainMemberSchema.safeParse({ ...member(), name: 'Nate’s 💻' }).success).toBe(true);
  });
});

describe('roster bodies', () => {
  it('parses each operation without rewriting anything', () => {
    const bodies = [
      {
        ...base(),
        seq: 0,
        prev: null,
        op: 'genesis',
        member: member(),
        recovery: { signingKey: key(), boxKey: key() },
      },
      { ...base(), op: 'add', member: member() },
      { ...base(), op: 'remove', memberId: randomUUID() },
      { ...base(), op: 'generation', generation: 2 },
      { ...base(), op: 'recovery', recovery: { signingKey: key(), boxKey: key() } },
    ];
    for (const body of bodies) {
      const parsed = keychainRosterBodySchema.safeParse(body);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual(body);
    }
  });

  it('refuses an unknown key, an unknown op, a first generation and a bad prev', () => {
    expect(
      keychainRosterBodySchema.safeParse({ ...base(), op: 'add', member: member(), x: 1 }).success,
    ).toBe(false);
    expect(keychainRosterBodySchema.safeParse({ ...base(), op: 'rename' }).success).toBe(false);
    expect(
      keychainRosterBodySchema.safeParse({ ...base(), op: 'generation', generation: 1 }).success,
    ).toBe(false);
    expect(
      keychainRosterBodySchema.safeParse({ ...base(), op: 'generation', generation: 2.5 }).success,
    ).toBe(false);
    expect(
      keychainRosterBodySchema.safeParse({
        ...base(),
        prev: 'A'.repeat(64),
        op: 'remove',
        memberId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      keychainRosterBodySchema.safeParse({ ...base(), v: 2, op: 'remove', memberId: randomUUID() })
        .success,
    ).toBe(false);
  });

  it('carries one or two signatures per entry', () => {
    const signature = { signer: 'recovery', signature: b64(randomBytes(64)) };
    expect(keychainEntrySchema.safeParse({ body: '{}', signatures: [] }).success).toBe(false);
    expect(keychainEntrySchema.safeParse({ body: '{}', signatures: [signature] }).success).toBe(
      true,
    );
    expect(
      keychainEntrySchema.safeParse({ body: '{}', signatures: [signature, signature, signature] })
        .success,
    ).toBe(false);
    expect(
      keychainEntrySchema.safeParse({
        body: '{}',
        signatures: [{ ...signature, signer: 'server' }],
      }).success,
    ).toBe(false);
  });
});

describe('requests', () => {
  it('creates a vault with exactly two wraps', () => {
    const wrap = {
      recipient: 'recovery',
      generation: 1,
      epk: key(),
      nonce: b64(randomBytes(24)),
      ciphertext: b64(randomBytes(96)),
      signer: randomUUID(),
      signature: b64(randomBytes(64)),
    };
    const genesis = {
      body: '{}',
      signatures: [{ signer: 'recovery', signature: b64(randomBytes(64)) }],
    };
    expect(keychainCreateRequestSchema.safeParse({ genesis, wraps: [wrap, wrap] }).success).toBe(
      true,
    );
    expect(keychainCreateRequestSchema.safeParse({ genesis, wraps: [wrap] }).success).toBe(false);
    expect(
      keychainCreateRequestSchema.safeParse({ genesis, wraps: [{ ...wrap, key: 'x' }, wrap] })
        .success,
    ).toBe(false);
  });

  it('puts an item only from no revision or a positive one', () => {
    const item = { generation: 1, nonce: b64(randomBytes(24)), ciphertext: b64(randomBytes(272)) };
    expect(keychainItemPutRequestSchema.safeParse({ baseRevision: null, ...item }).success).toBe(
      true,
    );
    expect(keychainItemPutRequestSchema.safeParse({ baseRevision: 3, ...item }).success).toBe(true);
    expect(keychainItemPutRequestSchema.safeParse({ baseRevision: 0, ...item }).success).toBe(
      false,
    );
    expect(keychainItemPutRequestSchema.safeParse({ ...item }).success).toBe(false);
  });

  it('pages items at most 500 at a time', () => {
    expect(keychainItemsQuerySchema.parse({})).toEqual({ since: 0, limit: 500 });
    expect(keychainItemsQuerySchema.parse({ since: '12', limit: '3' })).toEqual({
      since: 12,
      limit: 3,
    });
    expect(keychainItemsQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
    expect(keychainItemsQuerySchema.safeParse({ since: '-1' }).success).toBe(false);
  });

  it('resets with a re-verification or a root proof, nothing else', () => {
    expect(keychainResetRequestSchema.safeParse({ reauth: { password: 'pw' } }).success).toBe(true);
    expect(keychainResetRequestSchema.safeParse({ vaultKey: key() }).success).toBe(false);
    expect(REAUTH_ACTIONS).toContain('reset_keychain');
    expect(IDENTITY_PROOF_ACTIONS.keychainReset).toBe('keychain_reset');
  });
});
