/**
 * The Oxy Keychain's wire contract (ADR 0063, `docs/identity/keychain.md`).
 *
 * The API parses every `/keychain` request with these schemas and its answers
 * with the response schemas; clients check answers with the Zod-free checks in
 * `./client/keychain.ts` (`@oxy.so/contracts/client`), which mirror them.
 *
 * Every request object is STRICT (an unknown key is refused). Every binary
 * value is canonical base64url without padding, with its length fixed where the
 * bytes are (keys and enrollment nonces 32, AEAD nonces 24, signatures 64).
 *
 * The roster body schemas TRANSFORM NOTHING: the server requires an entry's
 * `body` to equal the JCS of its own parse, so a parse that trimmed, defaulted
 * or lower-cased a value would refuse a canonical body.
 *
 * Platform-agnostic — zod only, no react/react-native/expo. ESM-safe.
 */

import { z } from 'zod';
import {
  KEYCHAIN_BASE64URL_PATTERN,
  KEYCHAIN_BYTES32_PATTERN,
  KEYCHAIN_ENROLLMENT_STATUSES,
  KEYCHAIN_HASH_PATTERN,
  KEYCHAIN_ID_PATTERN,
  KEYCHAIN_LIMITS,
  KEYCHAIN_NONCE_PATTERN,
  KEYCHAIN_PLATFORMS,
  KEYCHAIN_RECOVERY,
  KEYCHAIN_SIGNATURE_PATTERN,
  type KeychainEnrollmentResponse,
  type KeychainEnrollmentsResponse,
  type KeychainItemResponse,
  type KeychainItemsResponse,
  type KeychainStateResponse,
  type KeychainWrapResponse,
} from './client/keychain';
import { integerCheck } from './numberChecks';
import { identityProofSchema } from './identityProof';
import { reauthProofSchema, secondFactorCodeSchema } from './signIn';
import { isoDateTime, utf16MaxLength, utf16MinLength } from './stringChecks';

export {
  KEYCHAIN_PLATFORMS,
  KEYCHAIN_ROSTER_OPS,
  KEYCHAIN_ENROLLMENT_STATUSES,
  KEYCHAIN_RECOVERY,
  KEYCHAIN_DOMAINS,
  KEYCHAIN_LIMITS,
  KEYCHAIN_ERROR_CODES,
  KEYCHAIN_ID_PATTERN,
  KEYCHAIN_BYTES32_PATTERN,
  KEYCHAIN_NONCE_PATTERN,
  KEYCHAIN_SIGNATURE_PATTERN,
  KEYCHAIN_BASE64URL_PATTERN,
  KEYCHAIN_HASH_PATTERN,
} from './client/keychain';
export type {
  KeychainPlatform,
  KeychainRosterOp,
  KeychainEnrollmentStatus,
  KeychainErrorCode,
  KeychainMember,
  KeychainRecoveryKeys,
  KeychainRosterBody,
  KeychainSignature,
  KeychainEntry,
  KeychainWrap,
  KeychainVaultSummary,
  KeychainMemberStatus,
  KeychainStateResponse,
  KeychainWrapResponse,
  KeychainEnrollment,
  KeychainEnrollmentResponse,
  KeychainEnrollmentsResponse,
  KeychainItem,
  KeychainItemResponse,
  KeychainItemsResponse,
} from './client/keychain';

/* -------------------------------------------------------------------------- */
/*  Building blocks                                                           */
/* -------------------------------------------------------------------------- */

/** A lowercase uuid: vault, member, item and enrollment ids. */
export const keychainIdSchema = z.string().regex(KEYCHAIN_ID_PATTERN, 'Expected a lowercase uuid');

/** A member id or `recovery`: a wrap's recipient, a signature's signer. */
export const keychainPrincipalSchema = z.union([keychainIdSchema, z.literal(KEYCHAIN_RECOVERY)]);

/** 32 bytes as canonical base64url: an Ed25519 or X25519 public key, a 32-byte nonce, a commitment. */
export const keychainBytes32Schema = z
  .string()
  .regex(KEYCHAIN_BYTES32_PATTERN, 'Expected 32 bytes as canonical base64url');

/** A 24-byte XChaCha20-Poly1305 nonce as base64url. */
export const keychainNonceSchema = z
  .string()
  .regex(KEYCHAIN_NONCE_PATTERN, 'Expected 24 bytes as base64url');

/** A 64-byte Ed25519 signature as canonical base64url. */
export const keychainSignatureValueSchema = z
  .string()
  .regex(KEYCHAIN_SIGNATURE_PATTERN, 'Expected 64 bytes as canonical base64url');

/** A ciphertext (tag included) as canonical base64url, at most 64 KiB of characters. */
export const keychainCiphertextSchema = z
  .string()
  .check(utf16MinLength(22))
  .check(utf16MaxLength(KEYCHAIN_LIMITS.maxCiphertextLength))
  .regex(KEYCHAIN_BASE64URL_PATTERN, 'Expected canonical base64url');

const hashSchema = z.string().regex(KEYCHAIN_HASH_PATTERN, 'Expected a lowercase SHA-256 hex');
const generationSchema = z.number().check(integerCheck()).min(1).max(Number.MAX_SAFE_INTEGER);
const revisionSchema = z.number().check(integerCheck()).min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * A member's name: no control characters (C0, DEL, C1), no lone surrogate (JCS
 * cannot carry one) and no surrounding white space.
 */
function isPlainName(name: string): boolean {
  if (name.trim() !== name) return false;
  for (let index = 0; index < name.length; index++) {
    const unit = name.charCodeAt(index);
    if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = name.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export const keychainMemberSchema = z
  .object({
    id: keychainIdSchema,
    name: z
      .string()
      .check(utf16MinLength(1))
      .check(utf16MaxLength(KEYCHAIN_LIMITS.maxMemberNameLength))
      .refine(isPlainName, {
        message: 'A member name has no control characters and no surrounding spaces',
      }),
    platform: z.enum(KEYCHAIN_PLATFORMS),
    signingKey: keychainBytes32Schema,
    boxKey: keychainBytes32Schema,
  })
  .strict();

export const keychainRecoveryKeysSchema = z
  .object({ signingKey: keychainBytes32Schema, boxKey: keychainBytes32Schema })
  .strict();

const rosterBodyBase = {
  v: z.literal(1),
  vaultId: keychainIdSchema,
  seq: z.number().check(integerCheck()).min(0).max(Number.MAX_SAFE_INTEGER),
  prev: hashSchema.nullable(),
  createdAt: z.string().check(isoDateTime()),
};

/**
 * The parse of an entry's `body` (ADR 0063 D3). `seq`/`prev` continuity, the
 * signatures and the signer rules are the server's and every device's
 * verifier's, not the schema's; the schema only refuses a body that is not
 * one of the five shapes exactly.
 */
export const keychainRosterBodySchema = z.discriminatedUnion('op', [
  z
    .object({
      ...rosterBodyBase,
      op: z.literal('genesis'),
      member: keychainMemberSchema,
      recovery: keychainRecoveryKeysSchema,
    })
    .strict(),
  z.object({ ...rosterBodyBase, op: z.literal('add'), member: keychainMemberSchema }).strict(),
  z.object({ ...rosterBodyBase, op: z.literal('remove'), memberId: keychainIdSchema }).strict(),
  z
    .object({
      ...rosterBodyBase,
      op: z.literal('generation'),
      generation: generationSchema.min(2),
    })
    .strict(),
  z
    .object({ ...rosterBodyBase, op: z.literal('recovery'), recovery: keychainRecoveryKeysSchema })
    .strict(),
]);

export const keychainSignatureSchema = z
  .object({ signer: keychainPrincipalSchema, signature: keychainSignatureValueSchema })
  .strict();

/** A roster entry as it travels. One or two signatures (genesis has exactly two). */
export const keychainEntrySchema = z
  .object({
    body: z
      .string()
      .check(utf16MinLength(2))
      .check(utf16MaxLength(KEYCHAIN_LIMITS.maxEntryBodyLength)),
    signatures: z.array(keychainSignatureSchema).min(1).max(2),
  })
  .strict();

export const keychainWrapSchema = z
  .object({
    recipient: keychainPrincipalSchema,
    generation: generationSchema,
    epk: keychainBytes32Schema,
    nonce: keychainNonceSchema,
    ciphertext: keychainCiphertextSchema,
    signer: keychainPrincipalSchema,
    signature: keychainSignatureValueSchema,
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Requests                                                                  */
/* -------------------------------------------------------------------------- */

/** `POST /keychain`: the genesis entry, and the member's and the recovery wraps. */
export const keychainCreateRequestSchema = z
  .object({
    genesis: keychainEntrySchema,
    wraps: z.array(keychainWrapSchema).length(2),
  })
  .strict();
export type KeychainCreateRequest = z.infer<typeof keychainCreateRequestSchema>;

/** `POST /keychain/roster`: entries continuing the head, and the wraps they require. */
export const keychainRosterAppendRequestSchema = z
  .object({
    entries: z.array(keychainEntrySchema).min(1).max(KEYCHAIN_LIMITS.maxEntriesPerAppend),
    wraps: z
      .array(keychainWrapSchema)
      .max(KEYCHAIN_LIMITS.maxLiveMembers + 1)
      .default([]),
  })
  .strict();
export type KeychainRosterAppendRequest = z.infer<typeof keychainRosterAppendRequestSchema>;

/** `POST /keychain/enrollments`: the new device's member and its commitment. */
export const keychainEnrollmentCreateRequestSchema = z
  .object({ member: keychainMemberSchema, commitment: keychainBytes32Schema })
  .strict();
export type KeychainEnrollmentCreateRequest = z.infer<typeof keychainEnrollmentCreateRequestSchema>;

/** `POST /keychain/enrollments/:id/approver-nonce`. */
export const keychainApproverNonceRequestSchema = z
  .object({ memberId: keychainIdSchema, approverNonce: keychainBytes32Schema })
  .strict();
export type KeychainApproverNonceRequest = z.infer<typeof keychainApproverNonceRequestSchema>;

/** `POST /keychain/enrollments/:id/reveal`. */
export const keychainRevealRequestSchema = z
  .object({ deviceNonce: keychainBytes32Schema })
  .strict();
export type KeychainRevealRequest = z.infer<typeof keychainRevealRequestSchema>;

/** `POST /keychain/enrollments/:id/approve`: the `add` entry and the new member's wrap. */
export const keychainApproveRequestSchema = z
  .object({ entry: keychainEntrySchema, wrap: keychainWrapSchema })
  .strict();
export type KeychainApproveRequest = z.infer<typeof keychainApproveRequestSchema>;

/** `PUT /keychain/items/:itemId`. `baseRevision` is `null` only for an item that never existed. */
export const keychainItemPutRequestSchema = z
  .object({
    baseRevision: revisionSchema.nullable(),
    generation: generationSchema,
    nonce: keychainNonceSchema,
    ciphertext: keychainCiphertextSchema,
  })
  .strict();
export type KeychainItemPutRequest = z.infer<typeof keychainItemPutRequestSchema>;

/** `DELETE /keychain/items/:itemId`. */
export const keychainItemDeleteRequestSchema = z.object({ baseRevision: revisionSchema }).strict();
export type KeychainItemDeleteRequest = z.infer<typeof keychainItemDeleteRequestSchema>;

/** `GET /keychain/items?since=&limit=`. */
export const keychainItemsQuerySchema = z
  .object({
    since: z.coerce.number().check(integerCheck()).min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.coerce
      .number()
      .check(integerCheck())
      .min(1)
      .max(KEYCHAIN_LIMITS.maxItemsPage)
      .default(KEYCHAIN_LIMITS.maxItemsPage),
  })
  .strict();
export type KeychainItemsQuery = z.infer<typeof keychainItemsQuerySchema>;

export const keychainEnrollmentParamsSchema = z.object({ id: keychainIdSchema }).strict();
export const keychainItemParamsSchema = z.object({ itemId: keychainIdSchema }).strict();

/**
 * `DELETE /keychain` — the reset (ADR 0063 D6), with a fresh re-verification.
 *
 * - An account WITHOUT a linked root: `reauth` for `reset_keychain` (ADR 0030:
 *   its email code, or its password when it has no email; plus its
 *   authenticator's code when it has one).
 * - An account WITH a linked root (Commons, which has no email or password to
 *   re-verify with): `rootProof`, a root proof for the `keychain_reset` action
 *   over the payload `{ vaultId }` (ADR 0024 D7, challenge from
 *   `POST /identity/proof-challenge`), plus `totpCode` when it has an
 *   authenticator.
 */
export const keychainResetRequestSchema = z
  .object({
    reauth: reauthProofSchema.optional(),
    rootProof: identityProofSchema.optional(),
    totpCode: secondFactorCodeSchema.optional(),
  })
  .strict();
export type KeychainResetRequest = z.infer<typeof keychainResetRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  Responses (mirrored by the checks in ./client/keychain.ts)                */
/* -------------------------------------------------------------------------- */

const counterSchema = z.number().check(integerCheck()).nonnegative();
const positiveIntSchema = z.number().check(integerCheck()).positive();

const entryResponseSchema = z.object({
  body: z.string(),
  signatures: z.array(z.object({ signer: z.string(), signature: z.string() })),
});

const wrapResponseSchema = z.object({
  recipient: z.string(),
  generation: positiveIntSchema,
  epk: z.string(),
  nonce: z.string(),
  ciphertext: z.string(),
  signer: z.string(),
  signature: z.string(),
});

const memberResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(KEYCHAIN_PLATFORMS),
  signingKey: z.string(),
  boxKey: z.string(),
});

const enrollmentResponseSchema = z.object({
  id: z.string(),
  vaultId: z.string(),
  member: memberResponseSchema,
  commitment: z.string(),
  approverNonce: z.string().nullable(),
  approverMemberId: z.string().nullable(),
  deviceNonce: z.string().nullable(),
  status: z.enum(KEYCHAIN_ENROLLMENT_STATUSES),
  expiresAt: z.string(),
  createdAt: z.string(),
});

const itemResponseSchema = z.object({
  id: z.string(),
  revision: counterSchema,
  generation: positiveIntSchema,
  nonce: z.string().nullable(),
  ciphertext: z.string().nullable(),
  deletedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export const keychainStateResponseSchema: z.ZodType<KeychainStateResponse> = z.object({
  vault: z
    .object({
      id: z.string(),
      genesisHash: z.string(),
      rosterSeq: counterSchema,
      rosterHead: z.string(),
      generation: positiveIntSchema,
      revision: counterSchema,
    })
    .nullable(),
  roster: z.array(entryResponseSchema),
  members: z.array(z.object({ id: z.string(), orphaned: z.boolean(), removed: z.boolean() })),
  self: z.string().nullable(),
});

export const keychainWrapResponseSchema: z.ZodType<KeychainWrapResponse> = z.object({
  wrap: wrapResponseSchema,
});

export const keychainEnrollmentResponseSchema: z.ZodType<KeychainEnrollmentResponse> = z.object({
  enrollment: enrollmentResponseSchema,
});

export const keychainEnrollmentsResponseSchema: z.ZodType<KeychainEnrollmentsResponse> = z.object({
  enrollments: z.array(enrollmentResponseSchema),
});

export const keychainItemResponseSchema: z.ZodType<KeychainItemResponse> = z.object({
  item: itemResponseSchema,
});

export const keychainItemsResponseSchema: z.ZodType<KeychainItemsResponse> = z.object({
  items: z.array(itemResponseSchema),
  revision: counterSchema,
  more: z.boolean(),
});
