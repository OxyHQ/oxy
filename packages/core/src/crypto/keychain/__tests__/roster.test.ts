/**
 * The roster's rules (ADR 0063 D3), wraps against a verified roster (D4) and
 * the enrollment commitment and code (D5): round trips and every tamper.
 */
import { RECOVERY } from '../constants';
import { fromBase64Url, jcs, toBase64Url } from '../encoding';
import {
  enrollmentCommitment,
  enrollmentComparisonCode,
  generateEnrollmentNonce,
  verifyEnrollmentCommitment,
} from '../enrollment';
import { KeychainCryptoError, KeychainFormatError, KeychainRosterError } from '../errors';
import { exportPublicKeys, generateDeviceKeys, type KeychainKeyPairs, signBytes } from '../keys';
import { deriveRecoveryKeys, generateRecoveryKey } from '../recoveryKey';
import {
  addBody,
  generationBody,
  genesisBody,
  type KeychainMember,
  parseRosterBody,
  type RosterEntry,
  type RosterHead,
  recoveryBody,
  removeBody,
  rosterHeadOf,
  rosterSigningInput,
  signRosterBody,
  type VerifiedRoster,
  verifyRoster,
} from '../roster';
import {
  createKeyring,
  createWrap,
  decodeKeyring,
  encodeKeyring,
  openWrap,
  rotateKeyring,
  verifyWrap,
  zeroizeKeyring,
} from '../wrap';

const VAULT = '11111111-2222-4333-8444-555555555555';
const OTHER_VAULT = '99999999-2222-4333-8444-555555555555';

interface Dev {
  id: string;
  keys: KeychainKeyPairs;
  member: KeychainMember;
}

let n = 0;
function newDevice(name = 'Device'): Dev {
  n += 1;
  const id = `0000abcd-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const keys = generateDeviceKeys();
  return { id, keys, member: { id, name, platform: 'oxyos', ...exportPublicKeys(keys) } };
}

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof KeychainRosterError) return error.reason;
    throw error;
  }
  return undefined;
}

function setup() {
  const a = newDevice('A');
  const b = newDevice('B');
  const recovery = deriveRecoveryKeys(generateRecoveryKey());
  const entries: RosterEntry[] = [
    signRosterBody(
      genesisBody({ vaultId: VAULT, member: a.member, recovery: exportPublicKeys(recovery) }),
      [
        { signer: a.id, signingSecretKey: a.keys.signingSecretKey },
        { signer: RECOVERY, signingSecretKey: recovery.signingSecretKey },
      ],
    ),
  ];
  const head = (): RosterHead => rosterHeadOf(entries[entries.length - 1]);
  entries.push(
    signRosterBody(addBody({ vaultId: VAULT, head: head(), member: b.member }), [
      { signer: a.id, signingSecretKey: a.keys.signingSecretKey },
    ]),
  );
  return { a, b, recovery, entries, head };
}

/** Sign an arbitrary body text (no validation), for tampering. */
function forge(body: string, signer: string, key: Uint8Array): RosterEntry {
  return {
    body,
    signatures: [{ signer, signature: toBase64Url(signBytes(key, rosterSigningInput(body))) }],
  };
}

function nextBodyText(entries: RosterEntry[], op: Record<string, unknown>): string {
  const head = rosterHeadOf(entries[entries.length - 1]);
  return jcs({
    v: 1,
    vaultId: VAULT,
    seq: head.seq + 1,
    prev: head.hash,
    createdAt: '2026-11-07T12:00:00.000Z',
    ...op,
  });
}

describe('roster', () => {
  it('verifies genesis → add → remove → generation → recovery', () => {
    const { a, b, recovery, entries, head } = setup();
    const c = newDevice('C');
    entries.push(
      signRosterBody(addBody({ vaultId: VAULT, head: head(), member: c.member }), [
        { signer: RECOVERY, signingSecretKey: recovery.signingSecretKey },
      ]),
    );
    entries.push(
      signRosterBody(removeBody({ vaultId: VAULT, head: head(), memberId: b.id }), [
        { signer: b.id, signingSecretKey: b.keys.signingSecretKey },
      ]),
    );
    entries.push(
      signRosterBody(generationBody({ vaultId: VAULT, head: head(), generation: 2 }), [
        { signer: c.id, signingSecretKey: c.keys.signingSecretKey },
      ]),
    );
    const recovery2 = deriveRecoveryKeys(generateRecoveryKey());
    entries.push(
      signRosterBody(
        recoveryBody({ vaultId: VAULT, head: head(), recovery: exportPublicKeys(recovery2) }),
        [{ signer: a.id, signingSecretKey: a.keys.signingSecretKey }],
      ),
    );
    const roster = verifyRoster(entries, { vaultId: VAULT });
    expect(roster.members.map((m) => m.id)).toEqual([a.id, c.id]);
    expect(roster.generation).toBe(2);
    expect(roster.recovery).toEqual(exportPublicKeys(recovery2));
    expect(roster.removedMemberIds).toEqual([b.id]);
    expect(roster.head.seq).toBe(5);
    // The old recovery key no longer signs.
    const late = forge(
      nextBodyText(entries, { op: 'add', member: newDevice().member }),
      RECOVERY,
      recovery.signingSecretKey,
    );
    expect(reasonOf(() => verifyRoster([...entries, late]))).toBe('signature');
  });

  it('pins the genesis and refuses anything that does not extend the known head', () => {
    const { a, entries, head } = setup();
    const roster = verifyRoster(entries);
    expect(
      verifyRoster(entries, { genesisHash: roster.genesisHash, knownHead: roster.head }).head,
    ).toEqual(roster.head);

    // A longer roster that extends it is fine.
    const c = newDevice();
    const longer = [
      ...entries,
      signRosterBody(addBody({ vaultId: VAULT, head: head(), member: c.member }), [
        { signer: a.id, signingSecretKey: a.keys.signingSecretKey },
      ]),
    ];
    expect(verifyRoster(longer, { knownHead: roster.head }).head.seq).toBe(2);
    // A shorter one (rolled back) is not.
    expect(
      reasonOf(() => verifyRoster(longer.slice(0, 2), { knownHead: verifyRoster(longer).head })),
    ).toBe('not_extension');
    // A fork: a different entry 1.
    const d = newDevice();
    const fork = [
      entries[0],
      signRosterBody(
        addBody({ vaultId: VAULT, head: rosterHeadOf(entries[0]), member: d.member }),
        [{ signer: a.id, signingSecretKey: a.keys.signingSecretKey }],
      ),
    ];
    expect(reasonOf(() => verifyRoster(fork, { knownHead: roster.head }))).toBe('not_extension');
    // Another vault altogether.
    const other = setup();
    expect(reasonOf(() => verifyRoster(other.entries, { genesisHash: roster.genesisHash }))).toBe(
      'genesis_mismatch',
    );
    expect(reasonOf(() => verifyRoster(entries, { vaultId: OTHER_VAULT }))).toBe('vault_mismatch');
  });

  it('refuses a rewritten entry (its signature no longer verifies)', () => {
    const { entries } = setup();
    const body = JSON.parse(entries[1].body);
    body.member.name = 'Mallory';
    const rewritten = { body: jcs(body), signatures: entries[1].signatures };
    expect(reasonOf(() => verifyRoster([entries[0], rewritten]))).toBe('signature');
  });

  it('refuses a foreign signer, a removed signer and a recovery signer where it may not sign', () => {
    const { a, b, recovery, entries, head } = setup();
    const x = newDevice();
    expect(
      reasonOf(() =>
        verifyRoster([
          ...entries,
          forge(
            nextBodyText(entries, { op: 'add', member: x.member }),
            x.id,
            x.keys.signingSecretKey,
          ),
        ]),
      ),
    ).toBe('signer');
    // A member's id with a foreign key.
    expect(
      reasonOf(() =>
        verifyRoster([
          ...entries,
          forge(
            nextBodyText(entries, { op: 'add', member: x.member }),
            a.id,
            x.keys.signingSecretKey,
          ),
        ]),
      ),
    ).toBe('signature');
    // Removed b then signs.
    const removed = [
      ...entries,
      signRosterBody(removeBody({ vaultId: VAULT, head: head(), memberId: b.id }), [
        { signer: a.id, signingSecretKey: a.keys.signingSecretKey },
      ]),
    ];
    removed.push(
      signRosterBody(
        generationBody({ vaultId: VAULT, head: rosterHeadOf(removed[2]), generation: 2 }),
        [{ signer: a.id, signingSecretKey: a.keys.signingSecretKey }],
      ),
    );
    expect(verifyRoster(removed).members.map((m) => m.id)).toEqual([a.id]);
    expect(
      reasonOf(() =>
        verifyRoster([
          ...removed,
          forge(
            nextBodyText(removed, { op: 'add', member: x.member }),
            b.id,
            b.keys.signingSecretKey,
          ),
        ]),
      ),
    ).toBe('signer');
    // The recovery key signs only genesis and add.
    for (const op of [
      { op: 'remove', memberId: b.id },
      { op: 'generation', generation: 2 },
      { op: 'recovery', recovery: exportPublicKeys(deriveRecoveryKeys(generateRecoveryKey())) },
    ]) {
      expect(
        reasonOf(() =>
          verifyRoster([
            ...entries,
            forge(nextBodyText(entries, op), RECOVERY, recovery.signingSecretKey),
          ]),
        ),
      ).toBe('signer');
    }
  });

  it('requires a generation right after a remove, at current + 1', () => {
    const { a, b, entries, head } = setup();
    const removed = [
      ...entries,
      signRosterBody(removeBody({ vaultId: VAULT, head: head(), memberId: b.id }), [
        { signer: a.id, signingSecretKey: a.keys.signingSecretKey },
      ]),
    ];
    expect(reasonOf(() => verifyRoster(removed))).toBe('incomplete');
    const x = newDevice();
    expect(
      reasonOf(() =>
        verifyRoster([
          ...removed,
          forge(
            nextBodyText(removed, { op: 'add', member: x.member }),
            a.id,
            a.keys.signingSecretKey,
          ),
        ]),
      ),
    ).toBe('incomplete');
    expect(
      reasonOf(() =>
        verifyRoster([
          ...removed,
          forge(
            nextBodyText(removed, { op: 'generation', generation: 3 }),
            a.id,
            a.keys.signingSecretKey,
          ),
        ]),
      ),
    ).toBe('generation');
    expect(() => generationBody({ vaultId: VAULT, head: head(), generation: 1 })).toThrow(
      KeychainFormatError,
    );
  });

  it('refuses removing a non-member and reusing an id', () => {
    const { a, b, entries, head } = setup();
    const stranger = newDevice();
    expect(
      reasonOf(() =>
        verifyRoster([
          ...entries,
          forge(
            nextBodyText(entries, { op: 'remove', memberId: stranger.id }),
            a.id,
            a.keys.signingSecretKey,
          ),
        ]),
      ),
    ).toBe('membership');
    expect(
      reasonOf(() =>
        verifyRoster([
          ...entries,
          signRosterBody(addBody({ vaultId: VAULT, head: head(), member: b.member }), [
            { signer: a.id, signingSecretKey: a.keys.signingSecretKey },
          ]),
        ]),
      ),
    ).toBe('membership');
  });

  it('refuses a genesis without both signatures, and two signatures from one signer', () => {
    const { a, entries } = setup();
    expect(
      reasonOf(() => verifyRoster([{ ...entries[0], signatures: [entries[0].signatures[0]] }])),
    ).toBe('signature');
    expect(
      reasonOf(() => verifyRoster([{ ...entries[0], signatures: [entries[0].signatures[1]] }])),
    ).toBe('signature');
    const dup = { ...entries[1], signatures: [entries[1].signatures[0], entries[1].signatures[0]] };
    expect(reasonOf(() => verifyRoster([entries[0], dup]))).toBe('signature');
    expect(reasonOf(() => verifyRoster([entries[1]]))).toBe('continuity');
    expect(reasonOf(() => verifyRoster([]))).toBe('genesis');
    void a;
  });

  it('refuses entries out of order or of another vault', () => {
    const { a, entries } = setup();
    const x = newDevice();
    const wrongSeq = jcs({
      ...JSON.parse(nextBodyText(entries, { op: 'add', member: x.member })),
      seq: 5,
    });
    expect(
      reasonOf(() => verifyRoster([...entries, forge(wrongSeq, a.id, a.keys.signingSecretKey)])),
    ).toBe('continuity');
    const wrongVault = jcs({
      ...JSON.parse(nextBodyText(entries, { op: 'add', member: x.member })),
      vaultId: OTHER_VAULT,
    });
    expect(
      reasonOf(() => verifyRoster([...entries, forge(wrongVault, a.id, a.keys.signingSecretKey)])),
    ).toBe('vault_mismatch');
  });

  it('keeps every schema closed', () => {
    const { entries } = setup();
    const body = JSON.parse(entries[1].body);
    const variants = [
      { ...body, extra: 1 },
      { ...body, member: { ...body.member, extra: 1 } },
      { ...body, member: { ...body.member, platform: 'beos' } },
      { ...body, member: { ...body.member, id: body.member.id.toUpperCase() } },
      { ...body, member: { ...body.member, name: '' } },
      { ...body, member: { ...body.member, name: 'x'.repeat(257) } },
      { ...body, member: { ...body.member, boxKey: toBase64Url(new Uint8Array(32)) } },
      { ...body, v: 2 },
      { ...body, op: 'promote' },
      { ...body, createdAt: '2026-11-07T12:00:00Z' },
      { ...body, prev: null },
    ];
    for (const v of variants) expect(() => parseRosterBody(jcs(v))).toThrow(KeychainFormatError);
    expect(() => parseRosterBody(JSON.stringify(body, null, 1))).toThrow(KeychainFormatError);
    expect(parseRosterBody(entries[1].body)).toEqual(body);
  });
});

describe('wraps', () => {
  function vault() {
    const s = setup();
    const roster = verifyRoster(s.entries);
    const keyring = createKeyring();
    const wrapFor = (recipient: string, boxKey: string, signer: string, key: Uint8Array) =>
      createWrap({
        vaultId: VAULT,
        recipient,
        recipientBoxKey: boxKey,
        keyring,
        signer,
        signingSecretKey: key,
      });
    return { ...s, roster, keyring, wrapFor };
  }

  it('round-trips to a member and to recovery', () => {
    const { a, b, recovery, roster, keyring, wrapFor } = vault();
    const toB = wrapFor(b.id, b.member.boxKey, a.id, a.keys.signingSecretKey);
    expect(openWrap(toB, roster, b.keys.boxSecretKey).keys.get(1)).toEqual(keyring.keys.get(1));
    const toRecovery = wrapFor(RECOVERY, roster.recovery.boxKey, a.id, a.keys.signingSecretKey);
    expect(openWrap(toRecovery, roster, recovery.boxSecretKey).generation).toBe(1);
    // A device admitted by recovery: its wrap is signed by the recovery key.
    const byRecovery = wrapFor(b.id, b.member.boxKey, RECOVERY, recovery.signingSecretKey);
    expect(verifyWrap(byRecovery, roster)).toEqual(byRecovery);
  });

  it('refuses a wrap tampered in any field', () => {
    const { a, b, roster, wrapFor } = vault();
    const wrap = wrapFor(b.id, b.member.boxKey, a.id, a.keys.signingSecretKey);
    const flip = (s: string) => {
      const bytes = fromBase64Url(s);
      bytes[3] ^= 1;
      return toBase64Url(bytes);
    };
    for (const tampered of [
      { ...wrap, recipient: a.id },
      { ...wrap, ciphertext: flip(wrap.ciphertext) },
      { ...wrap, nonce: flip(wrap.nonce) },
      { ...wrap, epk: exportPublicKeys(generateDeviceKeys()).boxKey },
      { ...wrap, signature: flip(wrap.signature) },
      { ...wrap, signer: b.id },
    ]) {
      expect(() => verifyWrap(tampered, roster)).toThrow(KeychainCryptoError);
    }
    expect(() => verifyWrap({ ...wrap, generation: 2 }, roster)).toThrow(KeychainCryptoError);
    expect(() => verifyWrap({ ...wrap, extra: 1 }, roster)).toThrow(KeychainFormatError);
    // Signed by a key that is not a member.
    const x = newDevice();
    expect(() =>
      verifyWrap(wrapFor(b.id, b.member.boxKey, x.id, x.keys.signingSecretKey), roster),
    ).toThrow(KeychainCryptoError);
    // Wrong recipient key: the box does not open for b.
    expect(() => openWrap(wrap, roster, a.keys.boxSecretKey)).toThrow(KeychainCryptoError);
  });

  it('refuses a wrap whose aad names another recipient or generation', () => {
    const { a, b, roster, keyring } = vault();
    // Sealed to b's key but labelled for a, re-signed by a: the aad differs, so a's open fails
    // and b's open fails too (its aad names a).
    const wrap = createWrap({
      vaultId: VAULT,
      recipient: a.id,
      recipientBoxKey: b.member.boxKey,
      keyring,
      signer: a.id,
      signingSecretKey: a.keys.signingSecretKey,
    });
    expect(verifyWrap(wrap, roster)).toEqual(wrap);
    expect(() => openWrap(wrap, roster, a.keys.boxSecretKey)).toThrow(KeychainCryptoError);
    const relabelled = createWrap({
      vaultId: VAULT,
      recipient: b.id,
      recipientBoxKey: b.member.boxKey,
      keyring,
      signer: a.id,
      signingSecretKey: a.keys.signingSecretKey,
    });
    expect(() => openWrap({ ...relabelled, recipient: a.id }, roster, b.keys.boxSecretKey)).toThrow(
      KeychainCryptoError,
    );
  });

  it('a rotation keeps every generation, and a removed member is no recipient', () => {
    const { a, b, entries, head, keyring } = vault();
    entries.push(
      signRosterBody(removeBody({ vaultId: VAULT, head: head(), memberId: b.id }), [
        { signer: a.id, signingSecretKey: a.keys.signingSecretKey },
      ]),
    );
    entries.push(
      signRosterBody(generationBody({ vaultId: VAULT, head: head(), generation: 2 }), [
        { signer: a.id, signingSecretKey: a.keys.signingSecretKey },
      ]),
    );
    const roster: VerifiedRoster = verifyRoster(entries);
    const rotated = rotateKeyring(keyring);
    expect(rotated.generation).toBe(2);
    const toA = createWrap({
      vaultId: VAULT,
      recipient: a.id,
      recipientBoxKey: a.member.boxKey,
      keyring: rotated,
      signer: a.id,
      signingSecretKey: a.keys.signingSecretKey,
    });
    const opened = openWrap(toA, roster, a.keys.boxSecretKey);
    expect(opened.keys.get(1)).toEqual(keyring.keys.get(1));
    expect(opened.keys.get(2)).toEqual(rotated.keys.get(2));
    const toB = createWrap({
      vaultId: VAULT,
      recipient: b.id,
      recipientBoxKey: b.member.boxKey,
      keyring: rotated,
      signer: a.id,
      signingSecretKey: a.keys.signingSecretKey,
    });
    expect(() => verifyWrap(toB, roster)).toThrow(KeychainCryptoError);
    // An old-generation wrap is refused once the roster has moved on.
    const old = createWrap({
      vaultId: VAULT,
      recipient: a.id,
      recipientBoxKey: a.member.boxKey,
      keyring,
      signer: a.id,
      signingSecretKey: a.keys.signingSecretKey,
    });
    expect(() => verifyWrap(old, roster)).toThrow(KeychainCryptoError);
    zeroizeKeyring(opened);
    expect(opened.keys.get(1)?.every((x) => x === 0)).toBe(true);
  });

  it('keyring decoding is strict', () => {
    const keyring = rotateKeyring(createKeyring());
    const text = new TextDecoder().decode(encodeKeyring(keyring));
    expect(decodeKeyring(new TextEncoder().encode(text)).generation).toBe(2);
    const value = JSON.parse(text);
    const bad = [
      { generations: { '2': value.generations['2'] } },
      { generations: { '01': value.generations['1'] } },
      { generations: {} },
      { generations: { '1': toBase64Url(new Uint8Array(31)) } },
      { ...value, extra: true },
    ];
    for (const v of bad)
      expect(() => decodeKeyring(new TextEncoder().encode(jcs(v)))).toThrow(KeychainFormatError);
    expect(() => decodeKeyring(new TextEncoder().encode(`${text} `))).toThrow(KeychainFormatError);
  });
});

describe('enrollment', () => {
  it('a commitment opens only with its nonce and member', () => {
    const d = newDevice('New');
    const nonce = generateEnrollmentNonce();
    const commitment = enrollmentCommitment(VAULT, d.member, nonce);
    expect(verifyEnrollmentCommitment(VAULT, d.member, nonce, commitment)).toBe(true);
    expect(verifyEnrollmentCommitment(VAULT, d.member, generateEnrollmentNonce(), commitment)).toBe(
      false,
    );
    expect(verifyEnrollmentCommitment(VAULT, newDevice('New').member, nonce, commitment)).toBe(
      false,
    );
    expect(verifyEnrollmentCommitment(OTHER_VAULT, d.member, nonce, commitment)).toBe(false);
  });

  it('both sides compute the same six digits; a substituted key changes them', () => {
    const d = newDevice('New');
    const deviceNonce = generateEnrollmentNonce();
    const approverNonce = generateEnrollmentNonce();
    const code = enrollmentComparisonCode(VAULT, d.member, approverNonce, deviceNonce);
    expect(code).toMatch(/^\d{6}$/);
    expect(enrollmentComparisonCode(VAULT, { ...d.member }, approverNonce, deviceNonce)).toBe(code);
    const swapped = { ...d.member, boxKey: exportPublicKeys(generateDeviceKeys()).boxKey };
    // A different input; equal only by chance (1 in 10⁶), so compare the hashes' inputs instead.
    expect(enrollmentComparisonCode(VAULT, swapped, approverNonce, deviceNonce)).not.toBe(code);
    expect(() =>
      enrollmentComparisonCode(VAULT, d.member, new Uint8Array(31), deviceNonce),
    ).toThrow(KeychainFormatError);
  });
});
