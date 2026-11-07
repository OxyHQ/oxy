/**
 * The cross-implementation vectors (ADR 0063 D8): the committed `vectors.json`
 * must be exactly what the generator builds, and every value in it must be
 * reproduced by the implementation byte for byte. Where Node's own crypto
 * (OpenSSL) has the primitive — X25519, Ed25519, HKDF, SHA-256 — the value is
 * also recomputed through it, so the vectors do not rest on `@noble` alone.
 */
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  createHash,
  verify as nodeVerify,
  sign as nodeSign,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { RECOVERY } from '../constants';
import { fromBase64Url, jcs, toBase64Url, toHex } from '../encoding';
import {
  enrollmentCodeInput,
  enrollmentCommitInput,
  enrollmentCommitment,
  enrollmentComparisonCode,
  verifyEnrollmentCommitment,
} from '../enrollment';
import { KeychainRosterError } from '../errors';
import {
  decodeItemPlaintext,
  decryptItem,
  encodeItemPlaintext,
  encryptItemDeterministic,
  itemAad,
  type KeychainItem,
} from '../items';
import { deviceKeysFromSecrets } from '../keys';
import { deriveRecoveryKeys, formatRecoveryKey, parseRecoveryKey } from '../recoveryKey';
import { type RosterEntry, rosterEntryHash, rosterSigningInput, verifyRoster } from '../roster';
import { openSealed, sealDeterministic } from '../seal';
import { parseOtpauthUri, totpCode } from '../totp';
import {
  createWrapDeterministic,
  decodeKeyring,
  encodeKeyring,
  type Keyring,
  openWrap,
  verifyWrap,
  wrapAad,
  wrapSigningInput,
} from '../wrap';
import { buildVectors } from './vectorGenerator';

const VECTORS_PATH = join(__dirname, 'vectors.json');
const raw = readFileSync(VECTORS_PATH, 'utf8');
// biome-ignore lint/suspicious/noExplicitAny: the vector file is data checked field by field below
const vectors: any = JSON.parse(raw);

const d = (s: string) => fromBase64Url(s);
const utf8 = (s: string) => new TextEncoder().encode(s);
const b = (u: Uint8Array) => Buffer.from(u);

// ─── Independent primitives (Node / OpenSSL) ─────────────────────────────────

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

function nodeX25519Private(secret: Uint8Array) {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8, b(secret)]),
    format: 'der',
    type: 'pkcs8',
  });
}

function nodeEd25519Private(seed: Uint8Array) {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8, b(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
}

function nodeX25519(secret: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const pub = createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: toBase64Url(publicKey) },
    format: 'jwk',
  });
  return new Uint8Array(diffieHellman({ privateKey: nodeX25519Private(secret), publicKey: pub }));
}

function nodeX25519Public(secret: Uint8Array): string {
  return createPublicKey(nodeX25519Private(secret)).export({ format: 'jwk' }).x as string;
}

function nodeEd25519Public(seed: Uint8Array): string {
  return createPublicKey(nodeEd25519Private(seed)).export({ format: 'jwk' }).x as string;
}

function nodeEd25519Sign(seed: Uint8Array, message: Uint8Array): string {
  return toBase64Url(new Uint8Array(nodeSign(null, b(message), nodeEd25519Private(seed))));
}

function nodeEd25519Verify(publicKey: string, message: Uint8Array, signature: string): boolean {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
  return nodeVerify(null, b(message), key, b(d(signature)));
}

function nodeHkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', b(ikm), b(salt), Buffer.from(info, 'utf8'), length));
}

function nodeSha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(b(data)).digest('hex');
}

/** Open a sealed box with Node's X25519 + HKDF and noble's XChaCha20-Poly1305. */
function nodeOpenSealed(
  recipientSecret: Uint8Array,
  box: { epk: string; nonce: string; ciphertext: string },
  aad: Uint8Array,
): Uint8Array {
  const epk = d(box.epk);
  const recipient = d(nodeX25519Public(recipientSecret));
  const shared = nodeX25519(recipientSecret, epk);
  const key = nodeHkdf(shared, new Uint8Array([...epk, ...recipient]), 'oxy.keychain.seal.v1', 32);
  return xchacha20poly1305(key, d(box.nonce), aad).decrypt(d(box.ciphertext));
}

// ─── The file is current ─────────────────────────────────────────────────────

describe('vectors.json', () => {
  it('is exactly what the generator builds', () => {
    expect(raw).toBe(`${JSON.stringify(buildVectors(), null, 2)}\n`);
  });

  it('covers every format', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.seal.length).toBeGreaterThanOrEqual(3);
    expect(vectors.wraps.map((w: { recipient: string }) => w.recipient)).toContain(RECOVERY);
    expect(vectors.roster.entries.map((e: { op: string }) => e.op)).toEqual([
      'genesis',
      'add',
      'add',
      'remove',
      'generation',
      'recovery',
      'generation',
    ]);
    expect(new Set(vectors.items.map((i: { item: KeychainItem }) => i.item.type))).toEqual(
      new Set(['login', 'passkey', 'totp', 'note', 'wifi']),
    );
    expect(vectors.rosterRejections.length).toBeGreaterThanOrEqual(10);
    expect(vectors.totp.rfc6238).toHaveLength(18);
  });
});

// ─── Keys ────────────────────────────────────────────────────────────────────

describe('device keys', () => {
  it.each(Object.entries(vectors.devices))('%s: public keys of the secrets', (_name, v) => {
    // biome-ignore lint/suspicious/noExplicitAny: vector data
    const dev = v as any;
    const keys = deviceKeysFromSecrets(d(dev.signingSecretKey), d(dev.boxSecretKey));
    expect(toBase64Url(keys.signingPublicKey)).toBe(dev.signingPublicKey);
    expect(toBase64Url(keys.boxPublicKey)).toBe(dev.boxPublicKey);
    expect(nodeEd25519Public(d(dev.signingSecretKey))).toBe(dev.signingPublicKey);
    expect(nodeX25519Public(d(dev.boxSecretKey))).toBe(dev.boxPublicKey);
    expect(dev.member.signingKey).toBe(dev.signingPublicKey);
    expect(dev.member.boxKey).toBe(dev.boxPublicKey);
  });
});

describe('recovery keys', () => {
  it.each(vectors.recoveryKeys.map((v: { text: string }) => [v.text, v]))('%s', (_text, v) => {
    // biome-ignore lint/suspicious/noExplicitAny: vector data
    const r = v as any;
    expect(formatRecoveryKey(d(r.recoveryKey))).toBe(r.text);
    for (const input of r.parsesFrom)
      expect(toBase64Url(parseRecoveryKey(input))).toBe(r.recoveryKey);
    const keys = deriveRecoveryKeys(d(r.recoveryKey));
    expect(toBase64Url(keys.signingSecretKey)).toBe(r.signingSecretKey);
    expect(toBase64Url(keys.boxSecretKey)).toBe(r.boxSecretKey);
    expect(toBase64Url(keys.signingPublicKey)).toBe(r.signingPublicKey);
    expect(toBase64Url(keys.boxPublicKey)).toBe(r.boxPublicKey);
    const salt = utf8('oxy.keychain.recovery.v1');
    expect(toBase64Url(nodeHkdf(d(r.recoveryKey), salt, 'ed25519', 32))).toBe(r.signingSecretKey);
    expect(toBase64Url(nodeHkdf(d(r.recoveryKey), salt, 'x25519', 32))).toBe(r.boxSecretKey);
    expect(nodeEd25519Public(d(r.signingSecretKey))).toBe(r.signingPublicKey);
    expect(nodeX25519Public(d(r.boxSecretKey))).toBe(r.boxPublicKey);
  });

  it.each(vectors.recoveryKeyRejections.map((t: string) => [t]))('refuses %j', (text) => {
    expect(() => parseRecoveryKey(text as string)).toThrow();
  });
});

// ─── Seal ────────────────────────────────────────────────────────────────────

describe('seal', () => {
  it.each(vectors.seal.map((v: unknown, i: number) => [i, v]))('vector %i', (_i, v) => {
    // biome-ignore lint/suspicious/noExplicitAny: vector data
    const s = v as any;
    const box = sealDeterministic(
      d(s.recipientBoxPublicKey),
      d(s.plaintext),
      d(s.aad),
      d(s.ephemeralSecretKey),
      d(s.nonce),
    );
    expect(box).toEqual(s.sealed);
    expect(nodeX25519Public(d(s.ephemeralSecretKey))).toBe(s.sealed.epk);
    expect(toBase64Url(openSealed(d(s.recipientBoxSecretKey), s.sealed, d(s.aad)))).toBe(
      s.plaintext,
    );
    expect(toBase64Url(nodeOpenSealed(d(s.recipientBoxSecretKey), s.sealed, d(s.aad)))).toBe(
      s.plaintext,
    );
  });

  it.each(vectors.sealRejectedBoxKeys.map((k: string) => [k]))(
    'refuses to seal to low-order key %s',
    (key) => {
      expect(() =>
        sealDeterministic(
          d(key as string),
          new Uint8Array(1),
          new Uint8Array(0),
          new Uint8Array(32).fill(7),
          new Uint8Array(24),
        ),
      ).toThrow();
    },
  );
});

// ─── Keyring and wraps ───────────────────────────────────────────────────────

function keyringFrom(generations: Record<string, string>): Keyring {
  const keys = new Map(
    Object.entries(generations).map(([g, k]) => [Number(g), d(k)] as [number, Uint8Array]),
  );
  return { keys, generation: keys.size };
}

describe('keyrings', () => {
  it.each(
    vectors.keyrings.map((k: { generations: object }) => [Object.keys(k.generations).length, k]),
  )('%i generations', (_n, v) => {
    // biome-ignore lint/suspicious/noExplicitAny: vector data
    const k = v as any;
    expect(new TextDecoder().decode(encodeKeyring(keyringFrom(k.generations)))).toBe(k.plaintext);
    const decoded = decodeKeyring(utf8(k.plaintext));
    expect(
      Object.fromEntries([...decoded.keys].map(([g, key]) => [String(g), toBase64Url(key)])),
    ).toEqual(k.generations);
  });
});

describe('roster', () => {
  const entries: RosterEntry[] = vectors.roster.entries.map((e: RosterEntry) => ({
    body: e.body,
    signatures: e.signatures,
  }));

  it('verifies to the expected state', () => {
    const verified = verifyRoster(entries);
    const { hashes: _h, ...state } = verified;
    expect(state).toEqual(vectors.roster.expected);
  });

  it.each(vectors.roster.entries.map((e: { op: string }, i: number) => [i, e.op, e]))(
    'entry %i (%s)',
    (i, _op, v) => {
      // biome-ignore lint/suspicious/noExplicitAny: vector data
      const e = v as any;
      expect(new TextDecoder().decode(rosterSigningInput(e.body))).toBe(e.signingInput);
      expect(e.signingInput).toBe(`oxy.keychain.roster.v1\n${e.body}`);
      expect(rosterEntryHash(e.body)).toBe(e.hash);
      expect(nodeSha256Hex(utf8(e.signingInput))).toBe(e.hash);
      expect(jcs(JSON.parse(e.body))).toBe(e.body);
      expect(JSON.parse(e.body).seq).toBe(i);
      // Every signature verifies in OpenSSL under its signer's key and is
      // reproduced byte for byte (Ed25519 is deterministic).
      const candidates: Array<{ id: string; publicKey: string; secret: string }> = [
        ...Object.values(vectors.devices).map(
          // biome-ignore lint/suspicious/noExplicitAny: vector data
          (dev: any) => ({
            id: dev.member.id,
            publicKey: dev.signingPublicKey,
            secret: dev.signingSecretKey,
          }),
        ),
        ...vectors.recoveryKeys.map(
          // biome-ignore lint/suspicious/noExplicitAny: vector data
          (r: any) => ({ id: RECOVERY, publicKey: r.signingPublicKey, secret: r.signingSecretKey }),
        ),
      ];
      for (const { signer, signature } of e.signatures) {
        const matching = candidates.filter(
          (c) => c.id === signer && nodeEd25519Verify(c.publicKey, utf8(e.signingInput), signature),
        );
        expect(matching).toHaveLength(1);
        expect(nodeEd25519Sign(d(matching[0].secret), utf8(e.signingInput))).toBe(signature);
      }
    },
  );

  it.each(vectors.rosterRejections.map((r: { name: string }) => [r.name, r]))(
    'refuses: %s',
    (_name, v) => {
      // biome-ignore lint/suspicious/noExplicitAny: vector data
      const r = v as any;
      let error: unknown;
      try {
        verifyRoster(r.entries, { knownHead: r.knownHead, genesisHash: r.genesisHash });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(KeychainRosterError);
      expect((error as KeychainRosterError).reason).toBe(r.reason);
    },
  );
});

describe('wraps', () => {
  const roster = verifyRoster(
    vectors.roster.entries.map((e: RosterEntry) => ({ body: e.body, signatures: e.signatures })),
  );

  it.each(vectors.wraps.map((w: { recipient: string }) => [w.recipient, w]))('to %s', (_r, v) => {
    // biome-ignore lint/suspicious/noExplicitAny: vector data
    const w = v as any;
    const keyring = decodeKeyring(utf8(w.keyringPlaintext));
    expect(toBase64Url(wrapAad(w.vaultId, w.recipient, w.wrap.generation))).toBe(w.aad);
    expect(new TextDecoder().decode(wrapSigningInput(w.vaultId, w.wrap))).toBe(w.signingInput);
    const recipientBoxKey =
      w.recipient === RECOVERY
        ? roster.recovery.boxKey
        : roster.members.find((m) => m.id === w.recipient)?.boxKey;
    const rebuilt = createWrapDeterministic(
      {
        vaultId: w.vaultId,
        recipient: w.recipient,
        recipientBoxKey: recipientBoxKey as string,
        keyring,
        signer: w.signer,
        signingSecretKey: d(w.signerSigningSecretKey),
      },
      d(w.ephemeralSecretKey),
      d(w.nonce),
    );
    expect(rebuilt).toEqual(w.wrap);
    expect(verifyWrap(w.wrap, roster)).toEqual(w.wrap);
    const opened = openWrap(w.wrap, roster, d(w.recipientBoxSecretKey));
    expect(new TextDecoder().decode(encodeKeyring(opened))).toBe(w.keyringPlaintext);
    expect(
      new TextDecoder().decode(nodeOpenSealed(d(w.recipientBoxSecretKey), w.wrap, d(w.aad))),
    ).toBe(w.keyringPlaintext);
    const signerKey =
      w.signer === RECOVERY
        ? roster.recovery.signingKey
        : roster.members.find((m) => m.id === w.signer)?.signingKey;
    expect(nodeEd25519Verify(signerKey as string, utf8(w.signingInput), w.wrap.signature)).toBe(
      true,
    );
  });
});

// ─── Items ───────────────────────────────────────────────────────────────────

describe('items', () => {
  it.each(vectors.items.map((i: { item: KeychainItem }) => [i.item.type, i.item.id, i]))(
    '%s %s',
    (_t, _id, v) => {
      // biome-ignore lint/suspicious/noExplicitAny: vector data
      const it = v as any;
      const keyring: Keyring = {
        keys: new Map([[it.generation, d(it.vaultKey)]]),
        generation: it.generation,
      };
      expect(jcs(it.item)).toBe(it.plaintextJcs);
      const padded = encodeItemPlaintext(it.item);
      expect(toBase64Url(padded)).toBe(it.paddedPlaintext);
      expect(padded.length % 256).toBe(0);
      expect(new TextDecoder().decode(padded).trimEnd()).toBe(it.plaintextJcs);
      expect(toBase64Url(itemAad(it.vaultId, it.itemId, it.generation))).toBe(it.aad);
      const enc = encryptItemDeterministic(
        it.vaultId,
        it.item,
        keyring,
        it.generation,
        d(it.nonce),
      );
      expect(enc).toEqual({
        generation: it.generation,
        nonce: it.nonce,
        ciphertext: it.ciphertext,
      });
      expect(decryptItem(it.vaultId, it.itemId, enc, keyring)).toEqual(it.item);
      const raw = xchacha20poly1305(d(it.vaultKey), d(it.nonce), d(it.aad)).decrypt(
        d(it.ciphertext),
      );
      expect(toBase64Url(raw)).toBe(it.paddedPlaintext);
      expect(decodeItemPlaintext(raw)).toEqual(it.item);
    },
  );

  it('includes a plaintext of exactly 256 bytes, which gets no padding', () => {
    const exact = vectors.items.find(
      (i: { plaintextJcs: string }) => utf8(i.plaintextJcs).length === 256,
    );
    expect(exact).toBeDefined();
    expect(d(exact.paddedPlaintext).length).toBe(256);
  });
});

// ─── Enrollment ──────────────────────────────────────────────────────────────

describe('enrollment', () => {
  it.each(vectors.enrollment.map((e: { code: string }) => [e.code, e]))('code %s', (_c, v) => {
    // biome-ignore lint/suspicious/noExplicitAny: vector data
    const e = v as any;
    const deviceNonce = d(e.deviceNonce);
    const approverNonce = d(e.approverNonce);
    expect(toBase64Url(enrollmentCommitInput(e.vaultId, e.member, deviceNonce))).toBe(
      e.commitInput,
    );
    expect(enrollmentCommitment(e.vaultId, e.member, deviceNonce)).toBe(e.commitment);
    expect(
      toBase64Url(
        createHash('sha256')
          .update(b(d(e.commitInput)))
          .digest(),
      ),
    ).toBe(e.commitment);
    expect(verifyEnrollmentCommitment(e.vaultId, e.member, deviceNonce, e.commitment)).toBe(true);
    expect(toBase64Url(enrollmentCodeInput(e.vaultId, e.member, approverNonce, deviceNonce))).toBe(
      e.codeInput,
    );
    expect(nodeSha256Hex(d(e.codeInput))).toBe(e.codeHash);
    expect(enrollmentComparisonCode(e.vaultId, e.member, approverNonce, deviceNonce)).toBe(e.code);
    const h = Buffer.from(e.codeHash, 'hex');
    expect(String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0')).toBe(e.code);
    const prefix = `oxy.keychain.enroll.code.v1\n${jcs({ vaultId: e.vaultId, member: e.member })}`;
    expect(toHex(d(e.codeInput).subarray(0, utf8(prefix).length))).toBe(toHex(utf8(prefix)));
  });

  it('exercises the zero padding of the code', () => {
    expect(vectors.enrollment.some((e: { code: string }) => e.code.startsWith('0'))).toBe(true);
  });
});

// ─── TOTP ────────────────────────────────────────────────────────────────────

describe('totp', () => {
  it.each(
    vectors.totp.rfc6238.map((t: { algorithm: string; unixSeconds: number }) => [
      t.algorithm,
      t.unixSeconds,
      t,
    ]),
  )('RFC 6238 %s at %i', (_a, _t, v) => {
    // biome-ignore lint/suspicious/noExplicitAny: vector data
    const t = v as any;
    expect(
      totpCode(
        { secret: d(t.secret), algorithm: t.algorithm, digits: t.digits, period: t.period },
        t.unixSeconds * 1000,
      ),
    ).toBe(t.code);
  });

  it.each(vectors.totp.otpauth.map((t: { uri: string }) => [t.uri, t]))('%s', (_u, v) => {
    // biome-ignore lint/suspicious/noExplicitAny: vector data
    const t = v as any;
    const parsed = parseOtpauthUri(t.uri);
    expect(toBase64Url(parsed.secret)).toBe(t.secret);
    expect({ ...parsed, secret: t.secret }).toEqual({
      secret: t.secret,
      algorithm: t.algorithm,
      digits: t.digits,
      period: t.period,
      issuer: t.issuer,
      account: t.account,
    });
    expect(totpCode(parsed, t.unixSeconds * 1000)).toBe(t.code);
  });
});
