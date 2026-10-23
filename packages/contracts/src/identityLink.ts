/**
 * Linking Commons to an account without a key (ADR 0029 D3) — the two-device
 * relay.
 *
 * An account without a key links a Commons root once, and becomes
 * self-custodied: its email is deleted and its phrase in Commons is how it gets
 * back in. The authority is the same as `POST /auth/link` (ADR 0024 D8): a root
 * proof (`link_identity`) by the key Commons holds over a one-use challenge,
 * and the account's own confirmation — a code just sent to its email (plus its
 * authenticator code when it has one). Only the transport is new, because the
 * two factors live on two devices:
 *
 *   1. The signed-in account (the "Link Commons" panel of `@oxy.so/services`)
 *      opens a link request → `{ linkId, challenge }`, shown as a QR
 *      (`oxycommons://link?id=…&c=…`).
 *   2. Commons scans it, reads the request (the account's id and username),
 *      signs the root proof over the challenge and posts it with its key.
 *   3. Both screens show the same 6-digit code, derived from the link id and
 *      that key (`deriveIdentityLinkCode` in `@oxy.so/core`); the person checks
 *      they match, so a photographed QR cannot slip another key in.
 *   4. The panel completes with the email code: the account gains the root,
 *      loses the email, and Commons signs in with it.
 *
 * The server stores only the challenge's hash; the challenge travels in the QR.
 */
import { z } from '@oxy.so/zod3';
import { identityProofSchema } from './identityProof';
import { reauthProofSchema } from './signIn';
// The Zod-free half of this contract lives in `./client/` (`@oxy.so/contracts/client`);
// it is re-exported here so the root entry is unchanged.
import {
  IDENTITY_LINK_STATUSES,
  IDENTITY_LINK_QR_PREFIX,
  LINK_ID,
  CHALLENGE,
  type IdentityLinkStatus,
} from './client/identityLink';
export {
  IDENTITY_LINK_STATUSES,
  IDENTITY_LINK_QR_PREFIX,
  buildIdentityLinkQrPayload,
  parseIdentityLinkQrPayload,
} from './client/identityLink';
export type { IdentityLinkStatus } from './client/identityLink';

export const identityLinkIdSchema = z
  .string()
  .trim()
  .regex(LINK_ID, 'linkId must be 32 lowercase hex characters');

/** `POST /identity/link` */
export interface IdentityLinkCreateResponse {
  linkId: string;
  /** The one-use `link_identity` proof challenge, hex. */
  challenge: string;
  /** Unix milliseconds. */
  expiresAt: number;
  qrPayload: string;
}

export const identityLinkCreateResponseSchema: z.ZodType<IdentityLinkCreateResponse> = z.object({
  linkId: identityLinkIdSchema,
  challenge: z.string().regex(CHALLENGE),
  expiresAt: z.number().int().positive(),
  qrPayload: z.string().startsWith(IDENTITY_LINK_QR_PREFIX),
});

/** `GET /identity/link/:linkId` — what both devices poll. */
export interface IdentityLinkState {
  status: IdentityLinkStatus;
  /** The account being linked: the proof's subject and actor. */
  userId: string;
  username: string | null;
  /** The key Commons signed with, once it has. */
  publicKey: string | null;
  audience: string;
  expiresAt: number;
}

export const identityLinkStateSchema: z.ZodType<IdentityLinkState> = z.object({
  status: z.enum(IDENTITY_LINK_STATUSES),
  userId: z.string().min(1),
  username: z.string().nullable(),
  publicKey: z.string().nullable(),
  audience: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

/** `POST /identity/link/:linkId/proof` — from Commons, no bearer. */
export const identityLinkProofRequestSchema = z
  .object({
    publicKey: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^04[0-9a-f]{128}$/, 'publicKey must be an uncompressed secp256k1 key'),
    proof: identityProofSchema,
  })
  .strict();
export type IdentityLinkProofRequest = z.infer<typeof identityLinkProofRequestSchema>;

/**
 * `POST /identity/link/:linkId/complete` — the account's own confirmation: a
 * code just sent to its email for this link, or its password when it has no
 * email (`reauth`, plus its authenticator code when it has one).
 */
export const identityLinkCompleteRequestSchema = z.object({ reauth: reauthProofSchema }).strict();
export type IdentityLinkCompleteRequest = z.infer<typeof identityLinkCompleteRequestSchema>;
