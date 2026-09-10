/**
 * Device-to-device identity transfer contracts (b3 Feature 2 — "add a device").
 *
 * SINGLE SOURCE OF TRUTH for the wire shape of the short-lived, unauthenticated
 * relay that carries E2E-encrypted key material from an existing (old) device to
 * a fresh (new) device so both end up holding the SAME secp256k1 private key
 * (key cloning). The relay is E2E-encrypted via an ephemeral secp256k1 ECDH
 * handshake: the server stores only the two ephemeral public keys plus an opaque
 * AEAD ciphertext + nonce and NEVER holds a decryption key.
 *
 * Flow:
 *  1. New device (no identity) generates an ephemeral pair and calls
 *     `POST /identity/device-transfer/init { newEphPub, newDeviceLabel? }` →
 *     `{ pairingId, expiresAt }`. The QR carries ONLY `pairingId` (not
 *     self-contained — mirrors the QR sign-in `approve-info` resolution).
 *  2. Old device (has identity) scans, resolves the request via
 *     `GET /identity/device-transfer/:pairingId` (returns `newEphPub` + label),
 *     derives `transferKey = HKDF(ECDH(oldEphPriv, newEphPub), pairingId,
 *     'oxy-device-transfer-v1')`, AEAD-encrypts `{ privateKey, publicKey }`, and
 *     calls `POST /identity/device-transfer/:pairingId/approve` with the
 *     ciphertext PLUS a fresh signature over
 *     `{ action:'approve_device_transfer', pairingId, timestamp }` made with the
 *     CURRENT identity key (dual-proof: a bearer alone cannot exfiltrate the key).
 *  3. New device (socket push or poll fallback) re-derives the same
 *     `transferKey` from `ECDH(newEphPriv, oldEphPub)`, decrypts, and imports the
 *     private key, then completes a NORMAL challenge/verify sign-in.
 *
 * The load-bearing response shapes are declared as explicit `interface`s (same
 * `moduleResolution: node` rationale as `UserNameResponse` / the identity/civic
 * contracts: a nested `z.infer<>` can degrade to `{}` under a consumer's
 * `moduleResolution: "node"`), with the runtime schemas annotated
 * `z.ZodType<Interface>`.
 *
 * Platform-agnostic — zod only, no react/react-native/expo, ESM-safe.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Shared field validators                                                   */
/* -------------------------------------------------------------------------- */

/** Lowercase/uppercase hex string (no `0x` prefix). */
const hexString = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]+$/, 'must be a hex string');

/**
 * A secp256k1 public key, hex-encoded — compressed (`02`/`03` + 32 bytes = 66
 * chars) or uncompressed (`04` + 64 bytes = 130 chars). The exact curve-point
 * validity is re-checked server-side; this only bounds the shape/length.
 */
const publicKeyHex = hexString.min(66).max(130);

/** DER-encoded ECDSA signature, hex (variable length, ~140–144 chars). */
const signatureHex = hexString.min(2).max(256);

/**
 * The 24-byte XChaCha20-Poly1305 nonce, hex (exactly 48 chars). Matches
 * `@oxy.so/core` `AEAD_NONCE_LENGTH` (24 bytes).
 */
const nonceHex = hexString.length(48);

/**
 * The AEAD ciphertext (Poly1305 tag appended), hex. The plaintext is the small
 * JSON `{ privateKey, publicKey }` (~200 bytes), so the ciphertext stays well
 * under the cap; the bound blunts relay-abuse via oversized blobs.
 */
const ciphertextHex = hexString.min(2).max(8192);

/* -------------------------------------------------------------------------- */
/*  Status                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pairing lifecycle:
 *  - `pending`  — created by the new device, awaiting the old device's approval.
 *  - `approved` — the old device sealed and posted the encrypted key material.
 *  - `denied`   — the old device explicitly cancelled the transfer.
 *  - `expired`  — the 3-minute TTL elapsed before approval.
 */
export const devicePairingStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'expired',
]);
export type DevicePairingStatus = z.infer<typeof devicePairingStatusSchema>;

/* -------------------------------------------------------------------------- */
/*  POST /identity/device-transfer/init                                       */
/* -------------------------------------------------------------------------- */

/** Request body for `POST /identity/device-transfer/init` (public). */
export const deviceTransferInitRequestSchema = z.object({
  /** The new device's ephemeral secp256k1 public key (single-use). */
  newEphPub: publicKeyHex,
  /** Optional human-readable label for the new device (e.g. "iPhone 15"). */
  newDeviceLabel: z.string().trim().min(1).max(120).optional(),
});
export type DeviceTransferInitRequest = z.infer<typeof deviceTransferInitRequestSchema>;

export interface DeviceTransferInitResponse {
  /** 128-bit single-use handle carried in the QR. Also the HKDF salt. */
  pairingId: string;
  /** ISO-8601 expiry (3 minutes from creation). */
  expiresAt: string;
}

export const deviceTransferInitResponseSchema: z.ZodType<DeviceTransferInitResponse> =
  z.object({
    pairingId: z.string(),
    expiresAt: z.string(),
  });

/* -------------------------------------------------------------------------- */
/*  GET /identity/device-transfer/:pairingId                                  */
/* -------------------------------------------------------------------------- */

export interface DeviceTransferInfoResponse {
  pairingId: string;
  /** The new device's ephemeral public key (so the old device can ECDH). */
  newDeviceEphemeralPublicKey: string;
  /** Optional new-device label supplied at init. */
  newDeviceLabel: string | null;
  status: DevicePairingStatus;
  /** ISO-8601 expiry. */
  expiresAt: string;
  /**
   * The old device's ephemeral public key — present ONLY once `status` is
   * `approved` (so the new device can re-derive the shared secret).
   */
  oldDeviceEphemeralPublicKey: string | null;
  /** AEAD ciphertext (hex) — present ONLY once `status` is `approved`. */
  ciphertext: string | null;
  /** AEAD nonce (hex) — present ONLY once `status` is `approved`. */
  nonce: string | null;
}

export const deviceTransferInfoResponseSchema: z.ZodType<DeviceTransferInfoResponse> =
  z.object({
    pairingId: z.string(),
    newDeviceEphemeralPublicKey: z.string(),
    newDeviceLabel: z.string().nullable(),
    status: devicePairingStatusSchema,
    expiresAt: z.string(),
    oldDeviceEphemeralPublicKey: z.string().nullable(),
    ciphertext: z.string().nullable(),
    nonce: z.string().nullable(),
  });

/* -------------------------------------------------------------------------- */
/*  POST /identity/device-transfer/:pairingId/approve                         */
/* -------------------------------------------------------------------------- */

/**
 * Request body for `POST /identity/device-transfer/:pairingId/approve`
 * (bearer-authenticated AND signature-proven). The `signature` covers
 * `JSON.stringify({ action:'approve_device_transfer', pairingId, timestamp })`
 * made with the caller's CURRENT identity key — dual-proof so a bearer token
 * alone can never exfiltrate the private key.
 */
export const deviceTransferApproveRequestSchema = z.object({
  /** The old device's ephemeral secp256k1 public key (single-use). */
  oldEphPub: publicKeyHex,
  /** AEAD ciphertext of `{ privateKey, publicKey }`, hex. */
  ciphertext: ciphertextHex,
  /** AEAD nonce, hex (24 bytes). */
  nonce: nonceHex,
  /** ECDSA (DER, hex) signature proving control of the CURRENT identity key. */
  signature: signatureHex,
  /** Signing timestamp (ms since epoch) — freshness-checked server-side. */
  timestamp: z.number().int().positive(),
});
export type DeviceTransferApproveRequest = z.infer<typeof deviceTransferApproveRequestSchema>;

export interface DeviceTransferApproveResponse {
  success: boolean;
  pairingId: string;
  status: DevicePairingStatus;
}

export const deviceTransferApproveResponseSchema: z.ZodType<DeviceTransferApproveResponse> =
  z.object({
    success: z.boolean(),
    pairingId: z.string(),
    status: devicePairingStatusSchema,
  });

/* -------------------------------------------------------------------------- */
/*  POST /identity/device-transfer/:pairingId/deny                            */
/* -------------------------------------------------------------------------- */

export interface DeviceTransferDenyResponse {
  success: boolean;
  pairingId: string;
  status: DevicePairingStatus;
}

export const deviceTransferDenyResponseSchema: z.ZodType<DeviceTransferDenyResponse> =
  z.object({
    success: z.boolean(),
    pairingId: z.string(),
    status: devicePairingStatusSchema,
  });
