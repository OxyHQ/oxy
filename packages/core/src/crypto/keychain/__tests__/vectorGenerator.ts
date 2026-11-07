/**
 * Builds `vectors.json`: the cross-implementation test vectors of the
 * keychain's formats (ADR 0063 D8). Every input is fixed (private keys,
 * ephemeral keys, nonces, ids, timestamps), so the output is deterministic.
 * `scripts/generate-keychain-vectors.ts` writes it; `vectors.test.ts` checks
 * the committed file is exactly what this builds and reproduces every value
 * independently.
 *
 * Binary values are base64url without padding; hashes are lowercase hex (as on
 * the wire); text is a JSON string.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { RECOVERY } from '../constants';
import { fromBase64Url, jcs, toBase64Url, toHex } from '../encoding';
import {
  enrollmentCodeInput,
  enrollmentCommitInput,
  enrollmentCommitment,
  enrollmentComparisonCode,
} from '../enrollment';
import {
  encodeItemPlaintext,
  encryptItemDeterministic,
  itemAad,
  type KeychainItem,
} from '../items';
import { deviceKeysFromSecrets, exportPublicKeys, type KeychainKeyPairs, signBytes } from '../keys';
import { deriveRecoveryKeys, formatRecoveryKey, parseRecoveryKey } from '../recoveryKey';
import {
  addBody,
  generationBody,
  genesisBody,
  type KeychainMember,
  type KeychainPlatform,
  type RosterBody,
  type RosterEntry,
  recoveryBody,
  removeBody,
  rosterEntryHash,
  rosterHeadOf,
  rosterSigningInput,
  signRosterBody,
  verifyRoster,
} from '../roster';
import { sealDeterministic } from '../seal';
import { encodeBase32Secret, type TotpAlgorithm, totpCode } from '../totp';
import {
  createWrapDeterministic,
  encodeKeyring,
  type Keyring,
  wrapAad,
  wrapSigningInput,
} from '../wrap';

/** Deterministic bytes for a label (SHA-256, truncated). */
export function fixedBytes(label: string, length = 32): Uint8Array {
  if (length > 32) throw new Error('fixedBytes gives at most 32 bytes');
  return sha256(utf8ToBytes(`oxy.keychain.vectors/${label}`)).slice(0, length);
}

const b64 = toBase64Url;
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export const VAULT_ID = '0193a5f2-7c1e-7b3a-9d4e-2f6a8b1c3d5e';
const T0 = '2026-11-07T12:00:00.000Z';
const at = (minute: number): string => new Date(Date.parse(T0) + minute * 60_000).toISOString();

interface Device {
  label: string;
  id: string;
  name: string;
  platform: KeychainPlatform;
  keys: KeychainKeyPairs;
}

function device(label: string, id: string, name: string, platform: KeychainPlatform): Device {
  return {
    label,
    id,
    name,
    platform,
    keys: deviceKeysFromSecrets(fixedBytes(`${label}/signing`), fixedBytes(`${label}/box`)),
  };
}

function member(d: Device): KeychainMember {
  return { id: d.id, name: d.name, platform: d.platform, ...exportPublicKeys(d.keys) };
}

function keyVector(d: Device) {
  return {
    signingSecretKey: b64(d.keys.signingSecretKey),
    signingPublicKey: b64(d.keys.signingPublicKey),
    boxSecretKey: b64(d.keys.boxSecretKey),
    boxPublicKey: b64(d.keys.boxPublicKey),
  };
}

// Member names carry JCS's string edge cases: quotes, backslash, slash, every
// short escape, other C0 controls (\u00XX, lowercase hex), DEL and U+2028
// (not escaped), non-ASCII BMP and astral characters (raw UTF-8).
const DEVICES = {
  a: device(
    'device-a',
    '3f2b8c1e-5d47-4a90-b6e2-7c19d0a4f851',
    'Ana\'s "OxyOS" \\ laptop / ñ 😀  ',
    'oxyos',
  ),
  b: device(
    'device-b',
    '8e6d2a40-1b3c-4f5e-9a7d-0c2e4b6f8a1d',
    'Teléfono\u0000\u0001\u001f\b\f\n\r\t\u007f',
    'android',
  ),
  c: device('device-c', 'c41a9e72-6f0d-4b83-a5c2-91e7d3b08f64', '日本語のiPad 𝄞 </script>', 'ios'),
  d: device('device-d', '5a0c7e93-2d18-4f6b-8e41-b3d9f2a7c605', 'Work PC\u0007', 'windows'),
};

const RECOVERY_KEYS = [fixedBytes('recovery-1', 20), fixedBytes('recovery-2', 20)];
// Every character of the alphabet, in order: exercises each digit's value and
// the I/L → 1, O → 0 readings.
const ALPHABET_RECOVERY_KEY = parseRecoveryKey('0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ');

function recoveryKeyVector(bytes: Uint8Array) {
  const text = formatRecoveryKey(bytes);
  const keys = deriveRecoveryKeys(bytes);
  const compact = text.replace(/-/g, '');
  const variants = [
    text,
    text.toLowerCase(),
    compact,
    `  ${text.replace(/-/g, ' ')}\n`,
    text.replace(/1/g, 'l').replace(/0/g, 'o'),
    text.replace(/1/g, 'I').replace(/0/g, 'O').toLowerCase(),
    text.replace(/1/g, 'L').replace(/0/g, 'o').replace(/-/g, ' - '),
  ];
  return {
    recoveryKey: b64(bytes),
    text,
    parsesFrom: [...new Set(variants)],
    signingSecretKey: b64(keys.signingSecretKey),
    signingPublicKey: b64(keys.signingPublicKey),
    boxSecretKey: b64(keys.boxSecretKey),
    boxPublicKey: b64(keys.boxPublicKey),
  };
}

function buildSeal() {
  const recipient = DEVICES.a.keys;
  const cases = [
    {
      label: 'seal-1',
      plaintext: utf8ToBytes('The Oxy Keychain'),
      aad: utf8ToBytes('oxy.keychain.vectors.aad'),
    },
    { label: 'seal-2', plaintext: new Uint8Array(0), aad: new Uint8Array(0) },
    {
      label: 'seal-3',
      plaintext: fixedBytes('seal-3/plaintext'),
      aad: new Uint8Array([0, 1, 2, 0xff]),
    },
  ];
  return cases.map(({ label, plaintext, aad }) => {
    const ephemeralSecretKey = fixedBytes(`${label}/ephemeral`);
    const nonce = fixedBytes(`${label}/nonce`, 24);
    const box = sealDeterministic(
      recipient.boxPublicKey,
      plaintext,
      aad,
      ephemeralSecretKey,
      nonce,
    );
    return {
      recipientBoxSecretKey: b64(recipient.boxSecretKey),
      recipientBoxPublicKey: b64(recipient.boxPublicKey),
      ephemeralSecretKey: b64(ephemeralSecretKey),
      nonce: b64(nonce),
      plaintext: b64(plaintext),
      aad: b64(aad),
      sealed: box,
    };
  });
}

/** X25519 public keys of low order: a seal to them must be refused. */
function lowOrderBoxKeys(): string[] {
  const p = (1n << 255n) - 19n;
  const le = (n: bigint): Uint8Array => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
    return out;
  };
  return [
    0n,
    1n,
    p - 1n,
    p,
    p + 1n,
    BigInt('325606250916557431795983626356110631294008115727848805560023387167927233504'),
    BigInt('39382357235489614581723060781553021112529911719440698176882885853963445705823'),
  ].map((n) => b64(le(n)));
}

function keyringOf(n: number): Keyring {
  const keys = new Map<number, Uint8Array>();
  for (let g = 1; g <= n; g += 1) keys.set(g, fixedBytes(`vault-key-${g}`));
  return { keys, generation: n };
}

function keyringVector(n: number) {
  const keyring = keyringOf(n);
  return {
    generations: Object.fromEntries([...keyring.keys].map(([g, k]) => [String(g), b64(k)])),
    plaintext: text(encodeKeyring(keyring)),
  };
}

interface Chain {
  entries: RosterEntry[];
  bodies: RosterBody[];
}

function append(chain: Chain, body: RosterBody, signers: Array<[string, Uint8Array]>): void {
  chain.bodies.push(body);
  chain.entries.push(
    signRosterBody(
      body,
      signers.map(([signer, signingSecretKey]) => ({ signer, signingSecretKey })),
    ),
  );
}

function head(chain: Chain) {
  return rosterHeadOf(chain.entries[chain.entries.length - 1]);
}

/** genesis(a) → add(b, by a) → add(c, by recovery) → remove(b, by a) → generation 2 (by c) → recovery (by a). */
function buildChain(): { chain: Chain; recovery: KeychainKeyPairs[] } {
  const recovery = RECOVERY_KEYS.map((r) => deriveRecoveryKeys(r));
  const { a, b, c } = DEVICES;
  const chain: Chain = { entries: [], bodies: [] };
  append(
    chain,
    genesisBody({
      vaultId: VAULT_ID,
      createdAt: at(0),
      member: member(a),
      recovery: exportPublicKeys(recovery[0]),
    }),
    [
      [a.id, a.keys.signingSecretKey],
      [RECOVERY, recovery[0].signingSecretKey],
    ],
  );
  append(
    chain,
    addBody({ vaultId: VAULT_ID, createdAt: at(1), head: head(chain), member: member(b) }),
    [[a.id, a.keys.signingSecretKey]],
  );
  append(
    chain,
    addBody({ vaultId: VAULT_ID, createdAt: at(2), head: head(chain), member: member(c) }),
    [[RECOVERY, recovery[0].signingSecretKey]],
  );
  append(
    chain,
    removeBody({ vaultId: VAULT_ID, createdAt: at(3), head: head(chain), memberId: b.id }),
    [[a.id, a.keys.signingSecretKey]],
  );
  append(
    chain,
    generationBody({ vaultId: VAULT_ID, createdAt: at(3), head: head(chain), generation: 2 }),
    [[c.id, c.keys.signingSecretKey]],
  );
  append(
    chain,
    recoveryBody({
      vaultId: VAULT_ID,
      createdAt: at(4),
      head: head(chain),
      recovery: exportPublicKeys(recovery[1]),
    }),
    [[a.id, a.keys.signingSecretKey]],
  );
  return { chain, recovery };
}

function entryVector(entry: RosterEntry, body: RosterBody) {
  return {
    op: body.op,
    body: entry.body,
    signingInput: text(rosterSigningInput(entry.body)),
    hash: rosterEntryHash(entry.body),
    signatures: entry.signatures,
  };
}

/** Re-sign `body` (an object, possibly invalid) as given, without validation. */
function rawEntry(bodyText: string, signers: Array<[string, Uint8Array]>): RosterEntry {
  const input = rosterSigningInput(bodyText);
  return {
    body: bodyText,
    signatures: signers.map(([signer, key]) => ({
      signer,
      signature: b64(signBytes(key, input)),
    })),
  };
}

function buildRosterRejections(chain: Chain, recovery: KeychainKeyPairs[]) {
  const { a, b, c, d } = DEVICES;
  const e = chain.entries;
  const bodyOf = (i: number) => JSON.parse(e[i].body) as Record<string, unknown>;
  const relink = (body: Record<string, unknown>, prevIndex: number) => ({
    ...body,
    prev: rosterEntryHash(e[prevIndex].body),
  });
  const after = (n: number) => e.slice(0, n);
  const headAt = (n: number) => ({ seq: n - 1, hash: rosterEntryHash(e[n - 1].body) });

  // A different entry 2 (a fork): add d by a instead of c by recovery.
  const forkBody = jcs({ ...bodyOf(2), member: member(d) });
  const forked = [...after(2), rawEntry(forkBody, [[a.id, a.keys.signingSecretKey]])];

  const nextBody = (op: Record<string, unknown>, minute: number) =>
    jcs({
      v: 1,
      vaultId: VAULT_ID,
      seq: e.length,
      prev: rosterEntryHash(e[e.length - 1].body),
      createdAt: at(minute),
      ...op,
    });

  return [
    {
      name: 'fork: entry 2 differs from the head this device verified',
      reason: 'not_extension',
      knownHead: headAt(3),
      entries: forked,
    },
    {
      name: 'rewrite: a shorter history than the head this device verified',
      reason: 'not_extension',
      knownHead: headAt(e.length),
      entries: after(e.length - 1),
    },
    {
      name: 'pinned genesis differs',
      reason: 'genesis_mismatch',
      genesisHash: '0'.repeat(64),
      entries: e,
    },
    {
      name: 'foreign signer: an add signed by a key that is not a member',
      reason: 'signer',
      entries: [
        ...e,
        rawEntry(nextBody({ op: 'add', member: member(d) }, 5), [[d.id, d.keys.signingSecretKey]]),
      ],
    },
    {
      name: 'forged signature: an add claiming a member that did not sign it',
      reason: 'signature',
      entries: [
        ...e,
        rawEntry(nextBody({ op: 'add', member: member(d) }, 5), [[a.id, d.keys.signingSecretKey]]),
      ],
    },
    {
      name: 'removed signer: b signs after its removal',
      reason: 'signer',
      entries: [
        ...e,
        rawEntry(nextBody({ op: 'add', member: member(d) }, 5), [[b.id, b.keys.signingSecretKey]]),
      ],
    },
    {
      name: 'replaced recovery key signs an add',
      reason: 'signature',
      entries: [
        ...e,
        rawEntry(nextBody({ op: 'add', member: member(d) }, 5), [
          [RECOVERY, recovery[0].signingSecretKey],
        ]),
      ],
    },
    {
      name: 'recovery key signs a remove',
      reason: 'signer',
      entries: [
        ...e,
        rawEntry(nextBody({ op: 'remove', memberId: c.id }, 5), [
          [RECOVERY, recovery[1].signingSecretKey],
        ]),
      ],
    },
    {
      name: 'missing generation: the roster ends on a remove',
      reason: 'incomplete',
      entries: after(4),
    },
    {
      name: 'missing generation: a remove followed by an add',
      reason: 'incomplete',
      entries: [
        ...after(4),
        rawEntry(jcs({ ...relink(bodyOf(1), 3), seq: 4, member: member(d) }), [
          [a.id, a.keys.signingSecretKey],
        ]),
      ],
    },
    {
      name: 'generation skips a number',
      reason: 'generation',
      entries: [
        ...after(4),
        rawEntry(jcs({ ...bodyOf(4), generation: 3 }), [[c.id, c.keys.signingSecretKey]]),
      ],
    },
    {
      name: 'prev is not the previous entry',
      reason: 'continuity',
      entries: [
        ...after(2),
        rawEntry(jcs({ ...bodyOf(2), prev: rosterEntryHash(e[0].body) }), [
          [RECOVERY, recovery[0].signingSecretKey],
        ]),
      ],
    },
    {
      name: 'non-canonical body (whitespace)',
      reason: 'format',
      entries: [
        ...after(1),
        rawEntry(JSON.stringify(bodyOf(1), null, 1), [[a.id, a.keys.signingSecretKey]]),
      ],
    },
    {
      name: 'member has a field outside the schema',
      reason: 'format',
      entries: [
        ...after(1),
        rawEntry(jcs({ ...bodyOf(1), member: { ...member(b), extra: true } }), [
          [a.id, a.keys.signingSecretKey],
        ]),
      ],
    },
    {
      name: 'genesis signed by the member only',
      reason: 'signature',
      entries: [{ body: e[0].body, signatures: [e[0].signatures[0]] }],
    },
    {
      name: 'a member id is reused after its removal',
      reason: 'membership',
      entries: [
        ...e,
        rawEntry(nextBody({ op: 'add', member: member(b) }, 5), [[a.id, a.keys.signingSecretKey]]),
      ],
    },
  ];
}

function buildWraps(recovery: KeychainKeyPairs[]) {
  const keyring = keyringOf(2);
  const { a, c } = DEVICES;
  const cases: Array<{
    label: string;
    recipient: string;
    recipientBox: KeychainKeyPairs;
    signer: string;
    signerKeys: KeychainKeyPairs;
  }> = [
    { label: 'wrap-a', recipient: a.id, recipientBox: a.keys, signer: c.id, signerKeys: c.keys },
    {
      label: 'wrap-c',
      recipient: c.id,
      recipientBox: c.keys,
      signer: RECOVERY,
      signerKeys: recovery[1],
    },
    {
      label: 'wrap-recovery',
      recipient: RECOVERY,
      recipientBox: recovery[1],
      signer: a.id,
      signerKeys: a.keys,
    },
  ];
  return cases.map(({ label, recipient, recipientBox, signer, signerKeys }) => {
    const ephemeralSecretKey = fixedBytes(`${label}/ephemeral`);
    const nonce = fixedBytes(`${label}/nonce`, 24);
    const wrap = createWrapDeterministic(
      {
        vaultId: VAULT_ID,
        recipient,
        recipientBoxKey: b64(recipientBox.boxPublicKey),
        keyring,
        signer,
        signingSecretKey: signerKeys.signingSecretKey,
      },
      ephemeralSecretKey,
      nonce,
    );
    return {
      vaultId: VAULT_ID,
      recipient,
      recipientBoxSecretKey: b64(recipientBox.boxSecretKey),
      signer,
      signerSigningSecretKey: b64(signerKeys.signingSecretKey),
      ephemeralSecretKey: b64(ephemeralSecretKey),
      nonce: b64(nonce),
      keyringPlaintext: text(encodeKeyring(keyring)),
      aad: b64(wrapAad(VAULT_ID, recipient, keyring.generation)),
      signingInput: text(wrapSigningInput(VAULT_ID, wrap)),
      wrap,
    };
  });
}

const ITEM_IDS = {
  login: '0e8f6a52-3c71-4d29-8b04-6a1f9e2d7c35',
  passkey: '7b2d9f10-84c6-4e3a-a5f1-2c8e0d6b9a47',
  totp: 'a93c1e58-0f2b-4d76-9e8a-5b4d7c3f1e02',
  note: '2f6e8a1c-9b3d-4c50-8d7f-e1a2b4c6d8f9',
  noteExact: '6c4a2e80-1f3d-4b59-a7e6-d8c0b2f4a691',
  wifi: 'd5b7f931-a2c4-4e6b-8f0d-3e5a7c9b1d24',
};

function buildItems(): KeychainItem[] {
  const base = (id: string, counter: number) => ({
    id,
    v: 1 as const,
    createdAt: at(10),
    modifiedAt: at(20),
    counter,
  });
  const otpSecret = encodeBase32Secret(utf8ToBytes('12345678901234567890'));
  const exactNote = (body: string): KeychainItem => ({
    ...base(ITEM_IDS.noteExact, 1),
    type: 'note',
    title: 'Exactly 256',
    body,
  });
  // A note whose JCS is exactly 256 bytes: it gets no padding at all.
  const probe = jcs(exactNote(''));
  const exact = exactNote('x'.repeat(256 - utf8ToBytes(probe).length));
  return [
    {
      ...base(ITEM_IDS.login, 3),
      type: 'login',
      title: 'Example "Mail" ñ',
      username: 'ana@example.com',
      password: 'abcde-FGHIJ-k1m2n-OPq3r',
      urls: [{ url: 'https://mail.example.com/login' }, { url: 'https://example.co.uk' }],
      apps: ['so.oxy.mail', 'com.example.mail'],
      totp: `otpauth://totp/Example:ana%40example.com?secret=${otpSecret}&issuer=Example`,
      notes: 'line 1\nline 2\t😀',
      passwordHistory: [
        { password: 'older-password-2', changedAt: at(15) },
        { password: 'older-password-1', changedAt: at(12) },
      ],
    },
    {
      ...base(ITEM_IDS.passkey, 1),
      type: 'passkey',
      rpId: 'example.com',
      rpName: 'Example',
      userHandle: b64(fixedBytes('passkey/user-handle')),
      userName: 'ana@example.com',
      userDisplayName: 'Ana',
      credentialId: b64(fixedBytes('passkey/credential-id', 16)),
      algorithm: -7,
      privateKey: b64(fixedBytes('passkey/pkcs8-placeholder')),
      apps: [],
    },
    {
      ...base(ITEM_IDS.totp, 2),
      type: 'totp',
      title: 'GitHub',
      issuer: 'GitHub',
      account: 'ana',
      uri: `otpauth://totp/GitHub:ana?secret=${otpSecret}&issuer=GitHub&algorithm=SHA256&digits=8&period=60`,
      notes: '',
    },
    {
      ...base(ITEM_IDS.note, 1),
      type: 'note',
      title: 'Door code',
      body: '4711 — \u0000 \\ "quoted"  ',
    },
    exact,
    {
      ...base(ITEM_IDS.wifi, 1),
      type: 'wifi',
      ssid: 'Casa 🏠',
      password: 'correct horse battery',
      security: 'wpa3-sae',
      hidden: true,
    },
  ];
}

function buildItemVectors() {
  const keyring = keyringOf(2);
  return buildItems().map((item, i) => {
    const generation = i % 2 === 0 ? 2 : 1;
    const nonce = fixedBytes(`item-${item.id}/nonce`, 24);
    const encrypted = encryptItemDeterministic(VAULT_ID, item, keyring, generation, nonce);
    const padded = encodeItemPlaintext(item);
    return {
      vaultId: VAULT_ID,
      itemId: item.id,
      generation,
      vaultKey: b64(keyring.keys.get(generation) as Uint8Array),
      item,
      plaintextJcs: jcs(item),
      paddedPlaintext: b64(padded),
      aad: b64(itemAad(VAULT_ID, item.id, generation)),
      nonce: b64(nonce),
      ciphertext: encrypted.ciphertext,
    };
  });
}

function buildEnrollment() {
  const m = member(DEVICES.d);
  const deviceNonce = fixedBytes('enroll/device-nonce');
  const vectors = [];
  // The first approver nonce, and the first after it whose code starts with 0
  // (so the zero-padding is exercised).
  let found = false;
  for (let i = 0; i < 200 && vectors.length < 2; i += 1) {
    const approverNonce = fixedBytes(`enroll/approver-nonce-${i}`);
    const code = enrollmentComparisonCode(VAULT_ID, m, approverNonce, deviceNonce);
    if (i > 0 && (found || !code.startsWith('0'))) continue;
    if (i > 0) found = true;
    vectors.push({
      vaultId: VAULT_ID,
      member: m,
      deviceNonce: b64(deviceNonce),
      approverNonce: b64(approverNonce),
      commitInput: b64(enrollmentCommitInput(VAULT_ID, m, deviceNonce)),
      commitment: enrollmentCommitment(VAULT_ID, m, deviceNonce),
      codeInput: b64(enrollmentCodeInput(VAULT_ID, m, approverNonce, deviceNonce)),
      codeHash: toHex(sha256(enrollmentCodeInput(VAULT_ID, m, approverNonce, deviceNonce))),
      code,
    });
  }
  return vectors;
}

function withCode<
  T extends {
    secret: string;
    algorithm: TotpAlgorithm;
    digits: number;
    period: number;
    unixSeconds: number;
  },
>(v: T): T & { code: string } {
  const { secret, algorithm, digits, period } = v;
  return {
    ...v,
    code: totpCode(
      { secret: fromBase64Url(secret), algorithm, digits, period },
      v.unixSeconds * 1000,
    ),
  };
}

/** RFC 6238 Appendix B, plus otpauth URIs read and computed. */
function buildTotp() {
  const seeds = {
    SHA1: '12345678901234567890',
    SHA256: '12345678901234567890123456789012',
    SHA512: '1234567890123456789012345678901234567890123456789012345678901234',
  } as const;
  const table: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  const rfc6238 = table.flatMap(([time, s1, s256, s512]) =>
    (
      [
        ['SHA1', s1],
        ['SHA256', s256],
        ['SHA512', s512],
      ] as const
    ).map(([algorithm, code]) => ({
      secret: b64(utf8ToBytes(seeds[algorithm])),
      algorithm,
      digits: 8,
      period: 30,
      unixSeconds: time,
      code,
    })),
  );
  const sha1Base32 = encodeBase32Secret(utf8ToBytes(seeds.SHA1));
  const otpauth = [
    {
      uri: `otpauth://totp/Example:alice@google.com?secret=JBSWY3DPEHPK3PXP&issuer=Example`,
      secret: b64(Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef])),
      issuer: 'Example',
      account: 'alice@google.com',
      algorithm: 'SHA1' as TotpAlgorithm,
      digits: 6,
      period: 30,
      unixSeconds: 1111111109,
    },
    {
      uri: `OTPAUTH://TOTP/ACME%20Co:john.doe%40email.com?secret=${sha1Base32.toLowerCase()}&issuer=ACME+Co&algorithm=sha256&digits=7&period=60&image=https%3A%2F%2Fexample.com%2Fi.png`,
      secret: b64(utf8ToBytes(seeds.SHA1)),
      issuer: 'ACME Co',
      account: 'john.doe@email.com',
      algorithm: 'SHA256' as TotpAlgorithm,
      digits: 7,
      period: 60,
      unixSeconds: 1234567890,
    },
    {
      uri: `otpauth://totp/Label%20Only?secret=${sha1Base32}====`,
      secret: b64(utf8ToBytes(seeds.SHA1)),
      issuer: '',
      account: 'Label Only',
      algorithm: 'SHA1' as TotpAlgorithm,
      digits: 6,
      period: 30,
      unixSeconds: 59,
    },
  ];
  return { rfc6238, otpauth };
}

export function buildVectors() {
  const { chain, recovery } = buildChain();
  const verified = verifyRoster(chain.entries);
  const totp = buildTotp();
  return {
    description:
      'Cross-implementation test vectors for the Oxy Keychain (oxy ADR 0063 D8). Generated by @oxy.so/core (packages/core/src/crypto/keychain/__tests__/vectorGenerator.ts) from fixed keys, ephemeral keys and nonces; @oxy.so/core and the OxyOS keychain service must both reproduce every value byte for byte. Binary values are base64url without padding; hashes are lowercase hex; text fields (bodies, signing inputs, JCS, keyring plaintexts) are the exact UTF-8 strings. The shape is documented in docs/identity/keychain.md#test-vectors.',
    version: 1,
    vaultId: VAULT_ID,
    devices: Object.fromEntries(
      Object.values(DEVICES).map((d) => [d.label, { member: member(d), ...keyVector(d) }]),
    ),
    recoveryKeys: [...RECOVERY_KEYS, ALPHABET_RECOVERY_KEY].map(recoveryKeyVector),
    recoveryKeyRejections: [
      'ABCD-EFGH',
      `${formatRecoveryKey(RECOVERY_KEYS[0])}-0`,
      formatRecoveryKey(RECOVERY_KEYS[0]).replace(/^./, 'U'),
      formatRecoveryKey(RECOVERY_KEYS[0]).replace(/^./, '*'),
      formatRecoveryKey(RECOVERY_KEYS[0]).replace(/^./, 'ı'),
    ],
    seal: buildSeal(),
    sealRejectedBoxKeys: lowOrderBoxKeys(),
    keyrings: [keyringVector(2), keyringVector(11)],
    wraps: buildWraps(recovery),
    roster: {
      entries: chain.bodies.map((body, i) => entryVector(chain.entries[i], body)),
      expected: {
        vaultId: verified.vaultId,
        genesisHash: verified.genesisHash,
        head: verified.head,
        members: verified.members,
        recovery: verified.recovery,
        generation: verified.generation,
        removedMemberIds: verified.removedMemberIds,
      },
    },
    rosterRejections: buildRosterRejections(chain, recovery),
    enrollment: buildEnrollment(),
    items: buildItemVectors(),
    totp: { ...totp, otpauth: totp.otpauth.map(withCode) },
  };
}
