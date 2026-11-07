/**
 * The Oxy Keychain's wire contract, without Zod (ADR 0063,
 * `docs/identity/keychain.md`). Schemas: `../keychain.ts`.
 *
 * Oxy stores only ciphertext, public keys, signatures and counters. Every
 * binary value is base64url WITHOUT padding, in its one canonical spelling
 * (the unused low bits of the last character are zero), so no two strings name
 * the same bytes.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import {
  array,
  boolean,
  exact,
  int,
  nonnegative,
  nullable,
  number,
  object,
  oneOf,
  positive,
  string,
} from './check';

/* -------------------------------------------------------------------------- */
/*  Closed sets and constants                                                 */
/* -------------------------------------------------------------------------- */

/** The platforms a member may name: a closed set, for display only (ADR 0063 D3). */
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

/** The roster's operations (ADR 0063 D3). */
export const KEYCHAIN_ROSTER_OPS = ['genesis', 'add', 'remove', 'generation', 'recovery'] as const;
export type KeychainRosterOp = (typeof KEYCHAIN_ROSTER_OPS)[number];

/** An enrollment's states. An expired pending one is answered `410`, never served as pending. */
export const KEYCHAIN_ENROLLMENT_STATUSES = ['pending', 'approved', 'denied'] as const;
export type KeychainEnrollmentStatus = (typeof KEYCHAIN_ENROLLMENT_STATUSES)[number];

/**
 * The recipient of the recovery wrap, and the signer named by a signature made
 * with the recovery signing key.
 */
export const KEYCHAIN_RECOVERY = 'recovery' as const;

/**
 * Every domain string (ADR 0063 D8). Each signing input, AAD and derivation
 * starts with one, so nothing signed or sealed as one kind can be replayed as
 * another.
 */
export const KEYCHAIN_DOMAINS = {
  roster: 'oxy.keychain.roster.v1',
  wrap: 'oxy.keychain.wrap.v1',
  item: 'oxy.keychain.item.v1',
  seal: 'oxy.keychain.seal.v1',
  enrollCommit: 'oxy.keychain.enroll.commit.v1',
  enrollCode: 'oxy.keychain.enroll.code.v1',
  recovery: 'oxy.keychain.recovery.v1',
} as const;

/** The server's limits (`docs/identity/keychain.md`). */
export const KEYCHAIN_LIMITS = {
  /** Live (non-deleted) items in one vault. */
  maxLiveItems: 10_000,
  /** An item's or a wrap's ciphertext, in base64url characters (64 KiB). */
  maxCiphertextLength: 65_536,
  /** Entries in one roster, genesis included. */
  maxRosterEntries: 1_000,
  /** Members not removed. */
  maxLiveMembers: 32,
  /** Unexpired pending enrollments per vault. */
  maxPendingEnrollments: 4,
  /** How long an enrollment waits for its approval. */
  enrollmentTtlMs: 10 * 60 * 1000,
  /** Items in one `GET /keychain/items` page. */
  maxItemsPage: 500,
  /** Entries in one roster append. */
  maxEntriesPerAppend: 64,
  /** One roster entry's `body`, in characters. */
  maxEntryBodyLength: 4_096,
  /** A member's display name, in bytes of UTF-8 (at least 1; any characters). */
  maxMemberNameBytes: 256,
} as const;

/**
 * Stable error codes the `/keychain` routes answer with (`error` in the API's
 * error body). Clients map these through their localization, never the English
 * message.
 */
export const KEYCHAIN_ERROR_CODES = {
  /** Not a personal account acting as itself. */
  notAvailable: 'KEYCHAIN_NOT_AVAILABLE',
  /** The bearer carries no device session, which a member is bound to. */
  deviceRequired: 'KEYCHAIN_DEVICE_REQUIRED',
  /** `POST /keychain`: the account already has a vault. */
  exists: 'KEYCHAIN_EXISTS',
  /** The account has no vault. */
  notFound: 'KEYCHAIN_NOT_FOUND',
  /** The caller's device session is bound to no live member of the vault. */
  notMember: 'KEYCHAIN_NOT_MEMBER',
  /** The caller's device session is already bound to a live member. */
  alreadyMember: 'KEYCHAIN_ALREADY_MEMBER',
  /** The entries do not continue the roster's head (a fork, a race, a stale head). */
  rosterConflict: 'KEYCHAIN_ROSTER_CONFLICT',
  /** An entry is malformed, non-canonical, badly signed, or breaks a roster rule. */
  rosterInvalid: 'KEYCHAIN_ROSTER_INVALID',
  /** A wrap is malformed, badly signed, or not the one the entries require. */
  wrapInvalid: 'KEYCHAIN_WRAP_INVALID',
  /**
   * A `remove` without its `generation`, or a `generation` without a wrap at
   * that generation for every remaining member and `recovery`.
   */
  rotationIncomplete: 'KEYCHAIN_ROTATION_INCOMPLETE',
  /** A limit of `KEYCHAIN_LIMITS` would be exceeded. */
  limitReached: 'KEYCHAIN_LIMIT_REACHED',
  /** No such enrollment for this vault. */
  enrollmentNotFound: 'KEYCHAIN_ENROLLMENT_NOT_FOUND',
  /** The enrollment's ten minutes are over. */
  enrollmentExpired: 'KEYCHAIN_ENROLLMENT_EXPIRED',
  /** The enrollment is not at the step this request takes (or was decided). */
  enrollmentState: 'KEYCHAIN_ENROLLMENT_STATE',
  /** The revealed device nonce does not open the commitment; the enrollment is denied. */
  commitmentMismatch: 'KEYCHAIN_COMMITMENT_MISMATCH',
  /** No such item, or it is deleted. */
  itemNotFound: 'KEYCHAIN_ITEM_NOT_FOUND',
  /** `baseRevision` is not the item's stored revision: re-read, merge, retry. */
  itemConflict: 'KEYCHAIN_ITEM_CONFLICT',
  /** An item's generation is not between 1 and the vault's. */
  generationInvalid: 'KEYCHAIN_GENERATION_INVALID',
  /** `DELETE /keychain` on an account with a linked root: a root proof is required. */
  resetProofRequired: 'KEYCHAIN_RESET_PROOF_REQUIRED',
} as const;
export type KeychainErrorCode = (typeof KEYCHAIN_ERROR_CODES)[keyof typeof KEYCHAIN_ERROR_CODES];

/* -------------------------------------------------------------------------- */
/*  Encodings                                                                 */
/* -------------------------------------------------------------------------- */

/** A lowercase uuid in its 8-4-4-4-12 form, any version: vault, member, item and enrollment ids. */
export const KEYCHAIN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A roster timestamp in its one spelling: UTC with milliseconds, as `Date#toISOString` writes it. */
export const KEYCHAIN_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** 32 bytes, canonical base64url (43 characters): keys, enrollment nonces, commitments. */
export const KEYCHAIN_BYTES32_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/** 24 bytes, base64url (32 characters): an XChaCha20-Poly1305 nonce. */
export const KEYCHAIN_NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
/** 64 bytes, canonical base64url (86 characters): an Ed25519 signature. */
export const KEYCHAIN_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{85}[AQgw]$/;
/** Any length of canonical base64url without padding. */
export const KEYCHAIN_BASE64URL_PATTERN =
  /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048]|[A-Za-z0-9_-][AQgw])?$/;
/** A roster entry's hash: lowercase hex SHA-256. */
export const KEYCHAIN_HASH_PATTERN = /^[0-9a-f]{64}$/;

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                    */
/* -------------------------------------------------------------------------- */

/** A device in the roster (ADR 0063 D3). `id` is a uuid the device chooses. */
export interface KeychainMember {
  id: string;
  name: string;
  platform: KeychainPlatform;
  /** Ed25519 public key. */
  signingKey: string;
  /** X25519 public key. */
  boxKey: string;
}

/** The recovery key's public halves, derived from it (ADR 0063 D8). */
export interface KeychainRecoveryKeys {
  signingKey: string;
  boxKey: string;
}

interface KeychainRosterBodyBase {
  v: 1;
  vaultId: string;
  seq: number;
  /** The previous entry's hash; `null` only at seq 0. */
  prev: string | null;
  /** The writer's clock, ISO 8601 UTC. Informational. */
  createdAt: string;
}

/**
 * A roster entry without its signatures: what `body` holds, as JCS. Its
 * signing input is `"oxy.keychain.roster.v1\n" ‖ body`; its hash is the hex
 * SHA-256 of that input.
 */
export type KeychainRosterBody =
  | (KeychainRosterBodyBase & {
      op: 'genesis';
      member: KeychainMember;
      recovery: KeychainRecoveryKeys;
    })
  | (KeychainRosterBodyBase & { op: 'add'; member: KeychainMember })
  | (KeychainRosterBodyBase & { op: 'remove'; memberId: string })
  | (KeychainRosterBodyBase & { op: 'generation'; generation: number })
  | (KeychainRosterBodyBase & { op: 'recovery'; recovery: KeychainRecoveryKeys });

/** One signature on an entry: a member id, or `recovery`. */
export interface KeychainSignature {
  signer: string;
  signature: string;
}

/** A roster entry as it travels: the JCS body exactly as signed, and its signatures. */
export interface KeychainEntry {
  body: string;
  signatures: KeychainSignature[];
}

/**
 * The keyring sealed to one recipient (a member id or `recovery`) and signed
 * by its sealer over `"oxy.keychain.wrap.v1\n" ‖ JCS({ vaultId, recipient,
 * generation, epk, nonce, ciphertext, signer })`.
 */
export interface KeychainWrap {
  recipient: string;
  generation: number;
  epk: string;
  nonce: string;
  ciphertext: string;
  signer: string;
  signature: string;
}

/** The vault's counters. */
export interface KeychainVaultSummary {
  id: string;
  genesisHash: string;
  rosterSeq: number;
  rosterHead: string;
  generation: number;
  revision: number;
}

/** What Oxy says about each member: whether its device session ended, whether it was removed. */
export interface KeychainMemberStatus {
  id: string;
  orphaned: boolean;
  removed: boolean;
}

/**
 * `GET /keychain` (and the answer of every roster write). No vault: `vault`
 * and `self` are `null` and the lists empty.
 */
export interface KeychainStateResponse {
  vault: KeychainVaultSummary | null;
  roster: KeychainEntry[];
  members: KeychainMemberStatus[];
  /** The live member bound to the caller's device session. */
  self: string | null;
}

/** `GET /keychain/wrap`, `GET /keychain/recovery`. */
export interface KeychainWrapResponse {
  wrap: KeychainWrap;
}

/** An enrollment (ADR 0063 D5). Timestamps are ISO 8601. */
export interface KeychainEnrollment {
  id: string;
  vaultId: string;
  member: KeychainMember;
  commitment: string;
  approverNonce: string | null;
  approverMemberId: string | null;
  deviceNonce: string | null;
  status: KeychainEnrollmentStatus;
  expiresAt: string;
  createdAt: string;
}

export interface KeychainEnrollmentResponse {
  enrollment: KeychainEnrollment;
}

export interface KeychainEnrollmentsResponse {
  enrollments: KeychainEnrollment[];
}

/** An item; a deleted one (tombstone) has `nonce`, `ciphertext` null and `deletedAt` set. */
export interface KeychainItem {
  id: string;
  revision: number;
  generation: number;
  nonce: string | null;
  ciphertext: string | null;
  deletedAt: string | null;
  updatedAt: string;
}

export interface KeychainItemResponse {
  item: KeychainItem;
}

/** `GET /keychain/items`: the changes after `since`, ascending, and the vault's revision. */
export interface KeychainItemsResponse {
  items: KeychainItem[];
  /** The vault's revision the page was read at. With `more: false`, the next `since`. */
  revision: number;
  /** More changes follow the last item: ask again with its revision. */
  more: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Response checks                                                           */
/* -------------------------------------------------------------------------- */

const counter = number(int, nonnegative);
const generation = number(int, positive);

const entryCheck = object({
  body: string(),
  signatures: array(object({ signer: string(), signature: string() })),
});

const wrapCheck = object({
  recipient: string(),
  generation,
  epk: string(),
  nonce: string(),
  ciphertext: string(),
  signer: string(),
  signature: string(),
});

const memberCheck = object({
  id: string(),
  name: string(),
  platform: oneOf(KEYCHAIN_PLATFORMS),
  signingKey: string(),
  boxKey: string(),
});

const enrollmentCheck = object({
  id: string(),
  vaultId: string(),
  member: memberCheck,
  commitment: string(),
  approverNonce: nullable(string()),
  approverMemberId: nullable(string()),
  deviceNonce: nullable(string()),
  status: oneOf(KEYCHAIN_ENROLLMENT_STATUSES),
  expiresAt: string(),
  createdAt: string(),
});

const itemCheck = object({
  id: string(),
  revision: counter,
  generation,
  nonce: nullable(string()),
  ciphertext: nullable(string()),
  deletedAt: nullable(string()),
  updatedAt: string(),
});

export const keychainStateResponseCheck = exact<KeychainStateResponse>()(
  object({
    vault: nullable(
      object({
        id: string(),
        genesisHash: string(),
        rosterSeq: counter,
        rosterHead: string(),
        generation,
        revision: counter,
      }),
    ),
    roster: array(entryCheck),
    members: array(object({ id: string(), orphaned: boolean, removed: boolean })),
    self: nullable(string()),
  }),
);

export const keychainWrapResponseCheck = exact<KeychainWrapResponse>()(object({ wrap: wrapCheck }));

export const keychainEnrollmentResponseCheck = exact<KeychainEnrollmentResponse>()(
  object({ enrollment: enrollmentCheck }),
);

export const keychainEnrollmentsResponseCheck = exact<KeychainEnrollmentsResponse>()(
  object({ enrollments: array(enrollmentCheck) }),
);

export const keychainItemResponseCheck = exact<KeychainItemResponse>()(object({ item: itemCheck }));

export const keychainItemsResponseCheck = exact<KeychainItemsResponse>()(
  object({ items: array(itemCheck), revision: counter, more: boolean }),
);
