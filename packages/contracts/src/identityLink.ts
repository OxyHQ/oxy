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
import { z } from 'zod';
import { identityProofSchema } from './identityProof';
import { emailReauthProofSchema } from './signIn';

export const IDENTITY_LINK_STATUSES = ['pending', 'signed', 'completed', 'cancelled'] as const;
export type IdentityLinkStatus = (typeof IDENTITY_LINK_STATUSES)[number];

/** The scheme and host Commons routes a link QR to. */
export const IDENTITY_LINK_QR_PREFIX = 'oxycommons://link';

const LINK_ID = /^[0-9a-f]{32}$/;
const CHALLENGE = /^[0-9a-f]{64}$/;

export const identityLinkIdSchema = z.string().trim().regex(LINK_ID, 'linkId must be 32 lowercase hex characters');

/** The QR auth.oxy.so shows: the request's id and the challenge Commons signs. */
export function buildIdentityLinkQrPayload(linkId: string, challenge: string): string {
    return `${IDENTITY_LINK_QR_PREFIX}?id=${linkId}&c=${challenge}`;
}

/** The request a scanned code names, or `null` for anything that is not a link QR. */
export function parseIdentityLinkQrPayload(raw: string): { linkId: string; challenge: string } | null {
    const value = raw.trim();
    if (!value.startsWith(`${IDENTITY_LINK_QR_PREFIX}?`)) return null;
    // Parsed by hand: React Native's `URLSearchParams` does not implement `get`.
    const params = new Map<string, string>();
    for (const pair of value.slice(IDENTITY_LINK_QR_PREFIX.length + 1).split('&')) {
        const separator = pair.indexOf('=');
        if (separator > 0) params.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const linkId = params.get('id') ?? '';
    const challenge = params.get('c') ?? '';
    if (!LINK_ID.test(linkId) || !CHALLENGE.test(challenge)) return null;
    return { linkId, challenge };
}

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
 * code just sent to its email for this link (`reauth`, plus its authenticator
 * code when it has one).
 */
export const identityLinkCompleteRequestSchema = z.object({ reauth: emailReauthProofSchema }).strict();
export type IdentityLinkCompleteRequest = z.infer<typeof identityLinkCompleteRequestSchema>;
