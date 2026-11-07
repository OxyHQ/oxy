/**
 * The Oxy Keychain's server-side verification (ADR 0063 D3, D4, D5, D8).
 *
 * Pure functions over the wire values: no database. Every device verifies the
 * same rules from the genesis entry, and THAT is what the security rests on;
 * the server checks them as well, on every write, as a defence in depth and to
 * keep garbage out of the roster every device has to read.
 *
 * Primitives only from audited libraries: Ed25519 from `@noble/curves`
 * (strict RFC 8032 verification, `zip215: false`, so a signature has one
 * encoding), SHA-256 from Node's crypto, JCS from `@oxy.so/protocol`'s
 * `canonicalize`. Nothing here is a cryptographic construction of its own.
 *
 * What is checked:
 *
 * - An entry's `body` parses to exactly one roster shape, and IS the JCS of
 *   that parse (a body with another key order, spacing, number spelling or a
 *   duplicate key is refused), so the bytes the signatures cover are the bytes
 *   every device re-derives.
 * - Continuity: `vaultId`, `seq` = head + 1, `prev` = the head's hash.
 * - Every signature verifies over `"oxy.keychain.roster.v1\n" ‖ body`, and its
 *   signer may sign that operation in the roster AS IT STANDS JUST BEFORE THE
 *   ENTRY (the order a device verifies in): a live member for every operation,
 *   or the current recovery key for an `add`.
 * - Wraps verify over `"oxy.keychain.wrap.v1\n" ‖ JCS({ vaultId, recipient,
 *   generation, epk, nonce, ciphertext, signer })`; which wraps a request must
 *   carry is decided by the caller (`requireWraps`).
 */

import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  KEYCHAIN_DOMAINS,
  KEYCHAIN_ERROR_CODES,
  KEYCHAIN_LIMITS,
  KEYCHAIN_RECOVERY,
  keychainRosterBodySchema,
  type KeychainEntry,
  type KeychainMember,
  type KeychainRecoveryKeys,
  type KeychainRosterBody,
  type KeychainSignature,
  type KeychainWrap,
} from '@oxy.so/contracts';
import { canonicalize } from '@oxy.so/protocol';
import { ApiError } from '../utils/error';

/* -------------------------------------------------------------------------- */
/*  Refusals                                                                  */
/* -------------------------------------------------------------------------- */

export function rosterInvalid(message: string): ApiError {
  return new ApiError(400, message, KEYCHAIN_ERROR_CODES.rosterInvalid);
}

export function rosterConflict(): ApiError {
  return new ApiError(
    409,
    'The keychain changed on another device. Read it again and retry.',
    KEYCHAIN_ERROR_CODES.rosterConflict,
  );
}

export function wrapInvalid(message: string): ApiError {
  return new ApiError(400, message, KEYCHAIN_ERROR_CODES.wrapInvalid);
}

export function rotationIncomplete(message: string): ApiError {
  return new ApiError(400, message, KEYCHAIN_ERROR_CODES.rotationIncomplete);
}

export function limitReached(message: string): ApiError {
  return new ApiError(409, message, KEYCHAIN_ERROR_CODES.limitReached);
}

/* -------------------------------------------------------------------------- */
/*  Encodings and primitives                                                  */
/* -------------------------------------------------------------------------- */

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');

/** The contracts already require canonical base64url; this only turns it into bytes. */
export function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function sha256(...parts: Uint8Array[]): Buffer {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** Strict Ed25519 verification; any malformed key or signature is simply `false`. */
export function verifyEd25519(signature: string, message: string, publicKey: string): boolean {
  try {
    return ed25519.verify(fromBase64Url(signature), utf8(message), fromBase64Url(publicKey), {
      zip215: false,
    });
  } catch {
    return false;
  }
}

/** `"oxy.keychain.roster.v1\n" ‖ body`. */
export function rosterSigningInput(body: string): string {
  return `${KEYCHAIN_DOMAINS.roster}\n${body}`;
}

/** An entry's hash: `hex(SHA-256(signing input))`. */
export function rosterEntryHash(body: string): string {
  return sha256(utf8(rosterSigningInput(body))).toString('hex');
}

/** `"oxy.keychain.wrap.v1\n" ‖ JCS({ vaultId, recipient, generation, epk, nonce, ciphertext, signer })`. */
export function wrapSigningInput(vaultId: string, wrap: KeychainWrap): string {
  return `${KEYCHAIN_DOMAINS.wrap}\n${canonicalize({
    vaultId,
    recipient: wrap.recipient,
    generation: wrap.generation,
    epk: wrap.epk,
    nonce: wrap.nonce,
    ciphertext: wrap.ciphertext,
    signer: wrap.signer,
  })}`;
}

/**
 * `SHA-256("oxy.keychain.enroll.commit.v1\n" ‖ JCS({ vaultId, member }) ‖ 0x00 ‖ deviceNonce)`,
 * base64url, with `deviceNonce` the raw 32 bytes.
 */
export function enrollmentCommitment(
  vaultId: string,
  member: KeychainMember,
  deviceNonce: string,
): string {
  const input = utf8(`${KEYCHAIN_DOMAINS.enrollCommit}\n${canonicalize({ vaultId, member })}`);
  return toBase64Url(sha256(input, new Uint8Array([0]), fromBase64Url(deviceNonce)));
}

/** Constant-time equality of two base64url values of the same kind. */
export function sameBase64Url(a: string, b: string): boolean {
  const left = Buffer.from(a, 'base64url');
  const right = Buffer.from(b, 'base64url');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/* -------------------------------------------------------------------------- */
/*  Entries                                                                   */
/* -------------------------------------------------------------------------- */

export interface ParsedEntry {
  body: KeychainRosterBody;
  /** The body exactly as received (and as signed). */
  raw: string;
  hash: string;
  signatures: KeychainSignature[];
}

/** Parse an entry's body strictly and require it to be the JCS of its own parse. */
export function parseEntry(entry: KeychainEntry): ParsedEntry {
  let json: unknown;
  try {
    json = JSON.parse(entry.body);
  } catch {
    throw rosterInvalid('A roster entry is not JSON.');
  }
  const parsed = keychainRosterBodySchema.safeParse(json);
  if (!parsed.success) throw rosterInvalid('A roster entry is not a valid entry.');
  let canonical: string;
  try {
    canonical = canonicalize(parsed.data);
  } catch {
    throw rosterInvalid('A roster entry is not a valid entry.');
  }
  if (canonical !== entry.body) {
    throw rosterInvalid('A roster entry is not in its canonical form (JCS).');
  }
  const signers = new Set(entry.signatures.map((signature) => signature.signer));
  if (signers.size !== entry.signatures.length) {
    throw rosterInvalid('A roster entry is signed twice by the same signer.');
  }
  return {
    body: parsed.data,
    raw: entry.body,
    hash: rosterEntryHash(entry.body),
    signatures: entry.signatures,
  };
}

/** One member as the verifier tracks it. */
export interface RosterMember {
  signingKey: string;
  boxKey: string;
  /** Not removed. */
  live: boolean;
}

/** The roster at its head, as far as the rules need it. */
export interface RosterState {
  vaultId: string;
  seq: number;
  head: string;
  generation: number;
  recovery: KeychainRecoveryKeys;
  /** Every member ever added, removed ones included (an id is never reused). */
  members: Map<string, RosterMember>;
}

export function liveMemberIds(state: RosterState): string[] {
  return [...state.members].filter(([, member]) => member.live).map(([id]) => id);
}

function cloneState(state: RosterState): RosterState {
  return {
    ...state,
    recovery: { ...state.recovery },
    members: new Map([...state.members].map(([id, member]) => [id, { ...member }])),
  };
}

function signingKeyOf(state: RosterState, signer: string, recoveryMaySign: boolean): string | null {
  if (signer === KEYCHAIN_RECOVERY) return recoveryMaySign ? state.recovery.signingKey : null;
  const member = state.members.get(signer);
  return member?.live ? member.signingKey : null;
}

function verifyEntrySignatures(state: RosterState, entry: ParsedEntry): void {
  const recoveryMaySign = entry.body.op === 'add';
  const input = rosterSigningInput(entry.raw);
  for (const { signer, signature } of entry.signatures) {
    const key = signingKeyOf(state, signer, recoveryMaySign);
    if (!key)
      throw rosterInvalid(
        `A roster entry is signed by ${signer === KEYCHAIN_RECOVERY ? 'the recovery key, which may not sign it' : 'a device that is not a member'}.`,
      );
    if (!verifyEd25519(signature, input, key)) {
      throw rosterInvalid('A roster entry has a signature that does not verify.');
    }
  }
}

/**
 * Verify a genesis entry (ADR 0063 D3) and return the roster it starts: seq 0,
 * no `prev`, signed by its member AND by the recovery key it names.
 */
export function verifyGenesis(entry: KeychainEntry): { parsed: ParsedEntry; state: RosterState } {
  const parsed = parseEntry(entry);
  const { body } = parsed;
  if (body.op !== 'genesis') throw rosterInvalid('The first roster entry must be a genesis.');
  if (body.seq !== 0 || body.prev !== null) {
    throw rosterInvalid('The genesis entry has seq 0 and no previous entry.');
  }
  const bySigner = new Map(parsed.signatures.map((s) => [s.signer, s.signature]));
  const memberSignature = bySigner.get(body.member.id);
  const recoverySignature = bySigner.get(KEYCHAIN_RECOVERY);
  if (parsed.signatures.length !== 2 || !memberSignature || !recoverySignature) {
    throw rosterInvalid('The genesis entry is signed by its member and by the recovery key.');
  }
  const input = rosterSigningInput(parsed.raw);
  if (
    !verifyEd25519(memberSignature, input, body.member.signingKey) ||
    !verifyEd25519(recoverySignature, input, body.recovery.signingKey)
  ) {
    throw rosterInvalid('A roster entry has a signature that does not verify.');
  }
  return {
    parsed,
    state: {
      vaultId: body.vaultId,
      seq: 0,
      head: parsed.hash,
      generation: 1,
      recovery: { ...body.recovery },
      members: new Map([
        [
          body.member.id,
          { signingKey: body.member.signingKey, boxKey: body.member.boxKey, live: true },
        ],
      ]),
    },
  };
}

/** What a verified append did, for the caller to persist and to decide the wraps. */
export interface AppliedAppend {
  entries: ParsedEntry[];
  /** The roster after the entries. */
  state: RosterState;
  added: KeychainMember[];
  removed: string[];
  /** The new generation, when the request rotates. */
  newGeneration: number | null;
  recoveryReplaced: boolean;
}

/**
 * Verify `entries` as the continuation of `base`, one at a time, each against
 * the roster as it stands just before it. The first entry not continuing the
 * head is a conflict (`409`, another device wrote first); every other failure
 * is the request's (`400`).
 */
export function applyEntries(base: RosterState, entries: KeychainEntry[]): AppliedAppend {
  const state = cloneState(base);
  const applied: ParsedEntry[] = [];
  const added: KeychainMember[] = [];
  const removed: string[] = [];
  let newGeneration: number | null = null;
  let recoveryReplaced = false;

  entries.forEach((entry, index) => {
    const parsed = parseEntry(entry);
    const { body } = parsed;
    if (body.vaultId !== state.vaultId) throw rosterInvalid('A roster entry names another vault.');
    if (body.seq !== state.seq + 1 || body.prev !== state.head) {
      if (index === 0) throw rosterConflict();
      throw rosterInvalid('The roster entries do not follow one another.');
    }
    if (body.seq >= KEYCHAIN_LIMITS.maxRosterEntries) {
      throw limitReached('This keychain has the most roster entries it can hold.');
    }
    verifyEntrySignatures(state, parsed);

    switch (body.op) {
      case 'genesis':
        throw rosterInvalid('A genesis entry starts a roster; it never continues one.');
      case 'add': {
        if (state.members.has(body.member.id)) {
          throw rosterInvalid('A member id is never added twice.');
        }
        if (liveMemberIds(state).length >= KEYCHAIN_LIMITS.maxLiveMembers) {
          throw limitReached('This keychain has the most devices it can hold.');
        }
        state.members.set(body.member.id, {
          signingKey: body.member.signingKey,
          boxKey: body.member.boxKey,
          live: true,
        });
        added.push(body.member);
        break;
      }
      case 'remove': {
        const member = state.members.get(body.memberId);
        if (!member?.live) throw rosterInvalid('Only a member can be removed.');
        member.live = false;
        removed.push(body.memberId);
        break;
      }
      case 'generation': {
        if (newGeneration !== null) {
          throw rosterInvalid('One request moves the vault key at most one generation.');
        }
        if (body.generation !== state.generation + 1) {
          throw rosterInvalid('A new generation is the current one plus one.');
        }
        state.generation = body.generation;
        newGeneration = body.generation;
        break;
      }
      case 'recovery': {
        state.recovery = { ...body.recovery };
        recoveryReplaced = true;
        break;
      }
    }
    state.seq = body.seq;
    state.head = parsed.hash;
    applied.push(parsed);
  });

  if (removed.length > 0 && newGeneration === null) {
    throw rotationIncomplete(
      'Removing a device moves the vault key to a new generation in the same request.',
    );
  }
  return { entries: applied, state, added, removed, newGeneration, recoveryReplaced };
}

/* -------------------------------------------------------------------------- */
/*  Wraps                                                                     */
/* -------------------------------------------------------------------------- */

export interface WrapRequirement {
  vaultId: string;
  /** Exactly these recipients, no more, no fewer. */
  recipients: ReadonlySet<string>;
  /** The vault's newest generation after the request: every wrap holds it. */
  generation: number;
  /** Who may have signed them, with their signing keys. */
  signers: ReadonlyMap<string, string>;
  /** The request rotates: a missing recipient is an incomplete rotation. */
  rotation: boolean;
}

/** Require exactly the wraps a request owes, each at the newest generation and validly signed. */
export function requireWraps(wraps: KeychainWrap[], requirement: WrapRequirement): void {
  const seen = new Set<string>();
  for (const wrap of wraps) {
    if (seen.has(wrap.recipient)) throw wrapInvalid('Two wraps for the same recipient.');
    seen.add(wrap.recipient);
    if (!requirement.recipients.has(wrap.recipient)) {
      throw wrapInvalid('A wrap for a recipient this request does not seal to.');
    }
    if (wrap.generation !== requirement.generation) {
      throw wrapInvalid("A wrap does not hold the vault key's newest generation.");
    }
    const key = requirement.signers.get(wrap.signer);
    if (!key) throw wrapInvalid('A wrap is signed by a device that may not seal it.');
    if (!verifyEd25519(wrap.signature, wrapSigningInput(requirement.vaultId, wrap), key)) {
      throw wrapInvalid('A wrap has a signature that does not verify.');
    }
  }
  for (const recipient of requirement.recipients) {
    if (!seen.has(recipient)) {
      if (requirement.rotation) {
        throw rotationIncomplete(
          'A new generation is sealed to every remaining device and to the recovery key in the same request.',
        );
      }
      throw wrapInvalid('A wrap this request owes is missing.');
    }
  }
}
