/**
 * The roster (ADR 0063 D3): the vault's membership as an append-only log of
 * entries signed by members, verified by every device from its first entry.
 *
 * An entry on the wire is `{ body, signatures: [{ signer, signature }] }`.
 * `body` is the JCS (RFC 8785) of the entry without its signatures:
 *
 *   { v: 1, vaultId, seq, prev, createdAt, op, …op fields }
 *
 *   genesis     member, recovery     signed by `member` AND by `recovery`
 *   add         member               signed by a current member, or `recovery`
 *   remove      memberId             signed by a current member (itself included)
 *   generation  generation           signed by a current member; current + 1
 *   recovery    recovery             signed by a current member
 *
 * `prev` is the previous entry's hash (`null` at seq 0); the hash of an entry
 * is `hex(SHA-256("oxy.keychain.roster.v1\n" ‖ body))`, the same bytes its
 * signatures cover. A `remove` and a `recovery` must each be followed by a
 * `generation` entry: the vault key moves on whenever a key that could open it
 * (a removed member's, a replaced recovery key's) stops being trusted.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { RECOVERY, ROSTER_DOMAIN, SIGNATURE_LENGTH } from './constants';
import {
  assertUuid,
  fromBase64Url,
  isKeychainTimestamp,
  isLowercaseUuid,
  jcs,
  keychainTimestamp,
  parseCanonicalJson,
  toBase64Url,
  toHex,
  utf8,
} from './encoding';
import { KeychainFormatError, KeychainRosterError } from './errors';
import { decodeBoxKey, decodeSigningKey, signBytes, verifyBytes } from './keys';

export const KEYCHAIN_PLATFORMS = [
  'oxyos',
  'ios',
  'android',
  'macos',
  'windows',
  'linux',
  'web',
] as const;
export type KeychainPlatform = (typeof KEYCHAIN_PLATFORMS)[number];

/** A member: one device of the person's. Keys are base64url. */
export interface KeychainMember {
  id: string;
  name: string;
  platform: KeychainPlatform;
  signingKey: string;
  boxKey: string;
}

/** The recovery key's public halves, base64url. */
export interface KeychainRecoveryPublicKeys {
  signingKey: string;
  boxKey: string;
}

interface RosterBodyBase {
  v: 1;
  vaultId: string;
  seq: number;
  prev: string | null;
  createdAt: string;
}

export type RosterBody =
  | (RosterBodyBase & {
      op: 'genesis';
      member: KeychainMember;
      recovery: KeychainRecoveryPublicKeys;
    })
  | (RosterBodyBase & { op: 'add'; member: KeychainMember })
  | (RosterBodyBase & { op: 'remove'; memberId: string })
  | (RosterBodyBase & { op: 'generation'; generation: number })
  | (RosterBodyBase & { op: 'recovery'; recovery: KeychainRecoveryPublicKeys });

export type RosterOp = RosterBody['op'];

/** One signature on an entry. `signer` is a member id or `recovery`. */
export interface RosterSignature {
  signer: string;
  signature: string;
}

/** An entry on the wire. */
export interface RosterEntry {
  body: string;
  signatures: RosterSignature[];
}

/** The newest entry a device has verified. */
export interface RosterHead {
  seq: number;
  hash: string;
}

/** Who signs an entry: a member id (or `recovery`) and its Ed25519 secret key. */
export interface RosterSigner {
  signer: string;
  signingSecretKey: Uint8Array;
}

/** What a verified roster says now. */
export interface VerifiedRoster {
  vaultId: string;
  /** The hash of entry 0: the vault's identity, pinned by every device. */
  genesisHash: string;
  head: RosterHead;
  /** The current members, in the order they were added. */
  members: KeychainMember[];
  /** The current recovery public keys. */
  recovery: KeychainRecoveryPublicKeys;
  /** The newest vault-key generation. */
  generation: number;
  /** Every member id that was removed. An id is never reused. */
  removedMemberIds: string[];
  /** Every entry's hash, by `seq`. */
  hashes: string[];
}

export interface VerifyRosterOptions {
  /** The vault id this device expects. */
  vaultId?: string;
  /** The genesis hash this device pinned when it joined. */
  genesisHash?: string;
  /** The newest head this device verified; the roster must extend it. */
  knownHead?: RosterHead;
}

// ─── Encoding ────────────────────────────────────────────────────────────────

/** `"oxy.keychain.roster.v1\n" ‖ body`: the bytes an entry's signatures cover. */
export function rosterSigningInput(body: string): Uint8Array {
  return utf8(`${ROSTER_DOMAIN}\n${body}`);
}

/** `hex(SHA-256(signing input))`. */
export function rosterEntryHash(body: string): string {
  return toHex(sha256(rosterSigningInput(body)));
}

const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_NAME_BYTES = 256;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(message: string): never {
  throw new KeychainFormatError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Refuse anything but exactly `keys` on `value`. */
export function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  what: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${what} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((k) => hasOwn(value, k))) {
    fail(`${what} must have exactly the fields ${keys.join(', ')}`);
  }
}

/** A member object, validated strictly; returns a fresh copy. */
export function parseMember(value: unknown, what = 'member'): KeychainMember {
  assertExactKeys(value, ['id', 'name', 'platform', 'signingKey', 'boxKey'], what);
  assertUuid(value.id, `${what}.id`);
  const { name, platform } = value;
  if (typeof name !== 'string') fail(`${what}.name must be text`);
  const nameBytes = utf8(name).length;
  if (nameBytes < 1 || nameBytes > MAX_NAME_BYTES) fail(`${what}.name must be 1 to 256 bytes`);
  if (
    typeof platform !== 'string' ||
    !(KEYCHAIN_PLATFORMS as readonly string[]).includes(platform)
  ) {
    fail(`${what}.platform is not a known platform`);
  }
  decodeSigningKey(value.signingKey as string, `${what}.signingKey`);
  decodeBoxKey(value.boxKey as string, `${what}.boxKey`);
  return {
    id: value.id,
    name,
    platform: platform as KeychainPlatform,
    signingKey: value.signingKey as string,
    boxKey: value.boxKey as string,
  };
}

/** Recovery public keys, validated strictly; returns a fresh copy. */
export function parseRecoveryPublicKeys(
  value: unknown,
  what = 'recovery',
): KeychainRecoveryPublicKeys {
  assertExactKeys(value, ['signingKey', 'boxKey'], what);
  decodeSigningKey(value.signingKey as string, `${what}.signingKey`);
  decodeBoxKey(value.boxKey as string, `${what}.boxKey`);
  return { signingKey: value.signingKey as string, boxKey: value.boxKey as string };
}

const BASE_KEYS = ['v', 'vaultId', 'seq', 'prev', 'createdAt', 'op'] as const;
const OP_KEYS: Record<RosterOp, readonly string[]> = {
  genesis: ['member', 'recovery'],
  add: ['member'],
  remove: ['memberId'],
  generation: ['generation'],
  recovery: ['recovery'],
};

/** Validate a body object strictly (closed schema per op); returns a fresh copy. */
export function validateRosterBody(value: unknown): RosterBody {
  if (!isPlainObject(value)) fail('roster body must be an object');
  const op = value.op as RosterOp;
  if (typeof op !== 'string' || !hasOwn(OP_KEYS, op)) fail('roster body has an unknown op');
  assertExactKeys(value, [...BASE_KEYS, ...OP_KEYS[op]], `roster ${op} body`);
  if (value.v !== 1) fail('roster body version must be 1');
  assertUuid(value.vaultId, 'vaultId');
  const seq = value.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0)
    fail('seq must be a non-negative integer');
  const prev = value.prev;
  if (seq === 0 ? prev !== null : typeof prev !== 'string' || !HASH_RE.test(prev)) {
    fail('prev must be null at seq 0 and a lowercase SHA-256 hex hash after');
  }
  if (!isKeychainTimestamp(value.createdAt))
    fail('createdAt must be an ISO 8601 UTC timestamp with milliseconds');
  const base: RosterBodyBase = {
    v: 1,
    vaultId: value.vaultId,
    seq,
    prev: prev as string | null,
    createdAt: value.createdAt,
  };
  switch (op) {
    case 'genesis':
      if (seq !== 0) fail('genesis must be seq 0');
      return {
        ...base,
        op,
        member: parseMember(value.member),
        recovery: parseRecoveryPublicKeys(value.recovery),
      };
    case 'add':
      return { ...base, op, member: parseMember(value.member) };
    case 'remove':
      assertUuid(value.memberId, 'memberId');
      return { ...base, op, memberId: value.memberId };
    case 'generation': {
      const g = value.generation;
      if (typeof g !== 'number' || !Number.isSafeInteger(g) || g < 2)
        fail('generation must be an integer ≥ 2');
      return { ...base, op, generation: g };
    }
    case 'recovery':
      return { ...base, op, recovery: parseRecoveryPublicKeys(value.recovery) };
  }
  return fail('roster body has an unknown op');
}

/** Parse an entry's `body` text: canonical JCS and a valid body, else throws. */
export function parseRosterBody(body: string): RosterBody {
  return validateRosterBody(parseCanonicalJson(body, 'roster body'));
}

// ─── Building entries ────────────────────────────────────────────────────────

interface BuildBase {
  vaultId: string;
  createdAt?: string;
}

interface BuildNext extends BuildBase {
  /** The current head the new entry continues. */
  head: RosterHead;
}

function base(input: BuildBase, seq: number, prev: string | null): RosterBodyBase {
  return {
    v: 1,
    vaultId: input.vaultId,
    seq,
    prev,
    createdAt: input.createdAt ?? keychainTimestamp(),
  };
}

function next(input: BuildNext): RosterBodyBase {
  return base(input, input.head.seq + 1, input.head.hash);
}

export function genesisBody(
  input: BuildBase & { member: KeychainMember; recovery: KeychainRecoveryPublicKeys },
): RosterBody {
  return validateRosterBody({
    ...base(input, 0, null),
    op: 'genesis',
    member: input.member,
    recovery: input.recovery,
  });
}

export function addBody(input: BuildNext & { member: KeychainMember }): RosterBody {
  return validateRosterBody({ ...next(input), op: 'add', member: input.member });
}

export function removeBody(input: BuildNext & { memberId: string }): RosterBody {
  return validateRosterBody({ ...next(input), op: 'remove', memberId: input.memberId });
}

export function generationBody(input: BuildNext & { generation: number }): RosterBody {
  return validateRosterBody({ ...next(input), op: 'generation', generation: input.generation });
}

export function recoveryBody(
  input: BuildNext & { recovery: KeychainRecoveryPublicKeys },
): RosterBody {
  return validateRosterBody({ ...next(input), op: 'recovery', recovery: input.recovery });
}

/** Sign a body: the entry's `body` text is its JCS; one signature per signer, in order. */
export function signRosterBody(body: RosterBody, signers: RosterSigner[]): RosterEntry {
  const text = jcs(validateRosterBody(body));
  const input = rosterSigningInput(text);
  return {
    body: text,
    signatures: signers.map(({ signer, signingSecretKey }) => ({
      signer,
      signature: toBase64Url(signBytes(signingSecretKey, input)),
    })),
  };
}

/** The head an entry makes: its `seq` and hash. */
export function rosterHeadOf(entry: RosterEntry): RosterHead {
  return { seq: parseRosterBody(entry.body).seq, hash: rosterEntryHash(entry.body) };
}

// ─── Verifying ───────────────────────────────────────────────────────────────

function parseEntryShape(
  entry: unknown,
  seq: number,
): { body: string; signatures: RosterSignature[] } {
  try {
    assertExactKeys(entry, ['body', 'signatures'], 'roster entry');
    if (typeof entry.body !== 'string') fail('roster entry body must be text');
    if (!Array.isArray(entry.signatures)) fail('roster entry signatures must be a list');
    const signatures = entry.signatures.map((s, i) => {
      assertExactKeys(s, ['signer', 'signature'], `signature ${i}`);
      if (s.signer !== RECOVERY && !isLowercaseUuid(s.signer))
        fail('a signer is a member id or recovery');
      if (typeof s.signature !== 'string') fail('a signature must be base64url');
      fromBase64Url(s.signature, SIGNATURE_LENGTH, 'signature');
      return { signer: s.signer as string, signature: s.signature };
    });
    return { body: entry.body, signatures };
  } catch (error) {
    throw new KeychainRosterError('format', (error as Error).message, seq);
  }
}

/**
 * Verify a whole roster from its genesis and say who the members are now.
 * Refuses (`KeychainRosterError`) anything that breaks D3: a non-canonical or
 * unknown body, a broken `seq`/`prev` chain, another vault's entry, a bad
 * signature, a signer that is not a current member at that point (or the
 * recovery key where it may not sign), an id reused, a `remove` or `recovery`
 * not followed by a `generation`, a generation that is not current + 1; and, with `options`,
 * a roster whose genesis is not the pinned one or that does not extend the
 * head this device already verified (a fork, a rewrite, a shorter history).
 */
export function verifyRoster(
  entries: readonly RosterEntry[],
  options: VerifyRosterOptions = {},
): VerifiedRoster {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new KeychainRosterError('genesis', 'a roster starts with its genesis entry');
  }

  const members = new Map<string, KeychainMember>();
  const everUsed = new Set<string>();
  const removed: string[] = [];
  const hashes: string[] = [];
  let recovery: KeychainRecoveryPublicKeys | null = null;
  let generation = 1;
  let vaultId = '';
  let pendingGeneration = false;

  for (let seq = 0; seq < entries.length; seq += 1) {
    const { body: text, signatures } = parseEntryShape(entries[seq], seq);
    let body: RosterBody;
    try {
      body = parseRosterBody(text);
    } catch (error) {
      throw new KeychainRosterError('format', (error as Error).message, seq);
    }
    if (body.seq !== seq) throw new KeychainRosterError('continuity', 'seq out of order', seq);
    if (seq === 0) {
      if (body.op !== 'genesis')
        throw new KeychainRosterError('genesis', 'the first entry must be genesis', seq);
      vaultId = body.vaultId;
      if (options.vaultId !== undefined && options.vaultId !== vaultId) {
        throw new KeychainRosterError('vault_mismatch', 'the roster is of another vault', seq);
      }
    } else {
      if (body.prev !== hashes[seq - 1])
        throw new KeychainRosterError('continuity', 'prev is not the previous entry', seq);
      if (body.vaultId !== vaultId)
        throw new KeychainRosterError('vault_mismatch', 'entry of another vault', seq);
    }
    if (pendingGeneration && body.op !== 'generation') {
      throw new KeychainRosterError(
        'incomplete',
        'a remove or recovery must be followed by a generation entry',
        seq,
      );
    }

    const input = rosterSigningInput(text);
    const signerKey = (signer: string, allowRecovery: boolean): string => {
      if (signer === RECOVERY) {
        if (!allowRecovery || recovery === null) {
          throw new KeychainRosterError('signer', 'the recovery key may not sign this entry', seq);
        }
        return recovery.signingKey;
      }
      const member = members.get(signer);
      if (!member) throw new KeychainRosterError('signer', 'signer is not a current member', seq);
      return member.signingKey;
    };
    const checkSignatures = (
      expected: number,
      allowRecovery: boolean,
      required?: string[],
    ): void => {
      if (signatures.length !== expected) {
        throw new KeychainRosterError('signature', `expected ${expected} signature(s)`, seq);
      }
      const seen = new Set<string>();
      for (const { signer, signature } of signatures) {
        if (seen.has(signer))
          throw new KeychainRosterError('signature', 'a signer signed twice', seq);
        seen.add(signer);
        const key = fromBase64Url(signerKey(signer, allowRecovery), 32);
        if (!verifyBytes(key, input, fromBase64Url(signature, SIGNATURE_LENGTH))) {
          throw new KeychainRosterError('signature', 'a signature does not verify', seq);
        }
      }
      if (required && !required.every((r) => seen.has(r))) {
        throw new KeychainRosterError('signer', 'a required signer is missing', seq);
      }
    };

    switch (body.op) {
      case 'genesis': {
        // Its signers are the member and the recovery key it introduces.
        members.set(body.member.id, body.member);
        recovery = body.recovery;
        checkSignatures(2, true, [body.member.id, RECOVERY]);
        everUsed.add(body.member.id);
        break;
      }
      case 'add': {
        checkSignatures(1, true);
        if (everUsed.has(body.member.id)) {
          throw new KeychainRosterError('membership', 'a member id is never reused', seq);
        }
        members.set(body.member.id, body.member);
        everUsed.add(body.member.id);
        break;
      }
      case 'remove': {
        checkSignatures(1, false);
        if (!members.has(body.memberId)) {
          throw new KeychainRosterError('membership', 'only a current member can be removed', seq);
        }
        members.delete(body.memberId);
        removed.push(body.memberId);
        pendingGeneration = true;
        break;
      }
      case 'generation': {
        checkSignatures(1, false);
        if (body.generation !== generation + 1) {
          throw new KeychainRosterError(
            'generation',
            'a generation must be the current one + 1',
            seq,
          );
        }
        generation = body.generation;
        pendingGeneration = false;
        break;
      }
      case 'recovery': {
        checkSignatures(1, false);
        recovery = body.recovery;
        // The replaced recovery key may have leaked, and the old recovery wrap
        // still opens with it: the vault key must move on (ADR 0063 D6).
        pendingGeneration = true;
        break;
      }
    }
    hashes.push(rosterEntryHash(text));
  }

  if (pendingGeneration) {
    throw new KeychainRosterError(
      'incomplete',
      'a remove or recovery must be followed by a generation entry',
      entries.length - 1,
    );
  }
  if (options.genesisHash !== undefined && options.genesisHash !== hashes[0]) {
    throw new KeychainRosterError(
      'genesis_mismatch',
      'the genesis is not the one this device pinned',
    );
  }
  if (options.knownHead !== undefined) {
    const { seq, hash } = options.knownHead;
    if (!(seq < hashes.length) || hashes[seq] !== hash) {
      throw new KeychainRosterError(
        'not_extension',
        'the roster does not extend the head this device verified',
      );
    }
  }

  return {
    vaultId,
    genesisHash: hashes[0],
    head: { seq: hashes.length - 1, hash: hashes[hashes.length - 1] },
    members: [...members.values()],
    recovery: recovery as unknown as KeychainRecoveryPublicKeys,
    generation,
    removedMemberIds: removed,
    hashes,
  };
}

/** The current member with this id, if any. */
export function findMember(roster: VerifiedRoster, memberId: string): KeychainMember | undefined {
  return roster.members.find((m) => m.id === memberId);
}

/**
 * The signing key a signer has now: a current member's, or the current
 * recovery key's for `recovery`. Undefined for anyone else.
 */
export function currentSigningKey(roster: VerifiedRoster, signer: string): string | undefined {
  if (signer === RECOVERY) return roster.recovery.signingKey;
  return findMember(roster, signer)?.signingKey;
}

/** The box key of a wrap recipient now: a current member's, or the recovery key's. */
export function currentBoxKey(roster: VerifiedRoster, recipient: string): string | undefined {
  if (recipient === RECOVERY) return roster.recovery.boxKey;
  return findMember(roster, recipient)?.boxKey;
}
