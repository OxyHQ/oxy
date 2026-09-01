/**
 * Device-to-device identity transfer service (b3 Feature 2 — "add a device").
 *
 * Backs the E2E-encrypted relay in `routes/deviceTransfer.ts`. All table access
 * and the security-critical logic (signature verification, atomic status burn)
 * live here so the route module stays a thin wrapper.
 *
 * The server NEVER decrypts: it only stores the ephemeral public keys and an
 * opaque ciphertext/nonce and shuttles them between the two devices. The threat
 * model is a PASSIVE / at-rest-compromised relay (DB dump, on-path capture) — a
 * shared transfer key requires an ephemeral PRIVATE key held only by one device,
 * so the stored material is undecryptable server-side. It is explicitly NOT
 * hardened against an actively-malicious backend MITM'ing the ephemeral keys
 * (same trust boundary as the existing QR sign-in; SAS compare deferred).
 *
 * ## Expiry: the read produces the verdict, the sweep only reclaims storage
 *
 * `device_pairing_sessions` is registered in `db/expiry.ts`, which lags one
 * interval exactly as Mongo's TTL monitor lagged ~60s. Both reads below
 * therefore keep filtering on the deadline THEMSELVES, verbatim
 * (`db/schema/CONVENTIONS.md`, "Expiry", class (A)):
 *
 *  - the lazy `pending` → `expired` write in {@link getDeviceTransferInfo} and
 *    {@link approveDeviceTransfer} is what lets a client be told "this pairing
 *    expired" rather than "unknown pairing", and
 *  - the atomic burn is conditioned on `expires_at > now()` in the SAME
 *    statement that claims the row, so a pairing past its deadline can never be
 *    approved even in the window before the sweep removes it.
 *
 * Dropping either because "the sweep handles it" turns a bounded lag into a
 * live credential-transfer window.
 */

import crypto from 'crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { devicePairingSessions } from '../db/schema/devicePairingSessions';
import { users } from '../db/schema/users';
import { SignatureService } from './signature.service';
import { logger } from '../utils/logger';
import type { DeviceTransferInfoResponse, DevicePairingStatus } from '@oxyhq/contracts';

/** Pairing lifetime — deliberately short (single interactive handoff). */
export const DEVICE_TRANSFER_TTL_MS = 3 * 60 * 1000;

/** Max age of the approval signature (freshness against replay). */
const APPROVAL_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * The exact bytes the old device signs (and the server reconstructs) to prove
 * possession of the CURRENT identity private key alongside its bearer token.
 * JSON.stringify preserves this key order — it MUST match the client byte-for-byte.
 */
export function buildApprovalSigningMessage(pairingId: string, timestamp: number): string {
  return JSON.stringify({ action: 'approve_device_transfer', pairingId, timestamp });
}

/* -------------------------------------------------------------------------- */
/*  init                                                                       */
/* -------------------------------------------------------------------------- */

export type InitDeviceTransferOutcome =
  | { ok: true; pairingId: string; expiresAt: Date }
  | { ok: false; status: 400; message: string };

/**
 * Register a new pairing from the fresh device's ephemeral public key. Public /
 * unauthenticated — the new device has no identity yet.
 */
export async function initDeviceTransfer(input: {
  newEphPub: string;
  newDeviceLabel?: string;
}): Promise<InitDeviceTransferOutcome> {
  const { newEphPub, newDeviceLabel } = input;

  if (!SignatureService.isValidPublicKey(newEphPub)) {
    return { ok: false, status: 400, message: 'Invalid ephemeral public key' };
  }

  const pairingId = crypto.randomBytes(16).toString('hex'); // 128-bit
  const expiresAt = new Date(Date.now() + DEVICE_TRANSFER_TTL_MS);

  await getDb().insert(devicePairingSessions).values({
    pairingId,
    newDeviceEphemeralPublicKey: newEphPub,
    newDeviceLabel: newDeviceLabel ?? null,
    status: 'pending',
    expiresAt,
  });

  return { ok: true, pairingId, expiresAt };
}

/* -------------------------------------------------------------------------- */
/*  info                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a pairing for either device: the old device reads `newEphPub` + label
 * before approving; the new device polls for the sealed material once approved.
 * Public — the QR is not self-contained, so the server is the resolver.
 *
 * Returns `null` when the pairing does not exist (route → 404). Marks a
 * past-TTL pending pairing as `expired` on read (see the header). The encrypted
 * material is surfaced ONLY once `status === 'approved'`.
 */
export async function getDeviceTransferInfo(
  pairingId: string,
): Promise<DeviceTransferInfoResponse | null> {
  const db = getDb();
  const [session] = await db
    .select()
    .from(devicePairingSessions)
    .where(eq(devicePairingSessions.pairingId, pairingId))
    .limit(1);
  if (!session) {
    return null;
  }

  let status: DevicePairingStatus = session.status;
  if (status === 'pending' && session.expiresAt < new Date()) {
    // Conditioned on the row still being `pending` so a concurrent approve
    // cannot be overwritten by this housekeeping write; when it loses, the
    // returned status is the one this read already observed.
    const [expired] = await db
      .update(devicePairingSessions)
      .set({ status: 'expired' })
      .where(
        and(
          eq(devicePairingSessions.id, session.id),
          eq(devicePairingSessions.status, 'pending')
        )
      )
      .returning({ status: devicePairingSessions.status });
    status = expired?.status ?? 'expired';
  }

  const approved = status === 'approved';
  return {
    pairingId: session.pairingId,
    newDeviceEphemeralPublicKey: session.newDeviceEphemeralPublicKey,
    newDeviceLabel: session.newDeviceLabel ?? null,
    status,
    expiresAt: session.expiresAt.toISOString(),
    oldDeviceEphemeralPublicKey: approved ? session.oldDeviceEphemeralPublicKey ?? null : null,
    ciphertext: approved ? session.ciphertext ?? null : null,
    nonce: approved ? session.nonce ?? null : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  approve                                                                    */
/* -------------------------------------------------------------------------- */

export interface ApproveDeviceTransferInput {
  pairingId: string;
  /** Bearer-resolved user id (never client-supplied). */
  authenticatedUserId: string;
  oldEphPub: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  timestamp: number;
}

export type ApproveDeviceTransferOutcome =
  | { ok: true; pairingId: string }
  | { ok: false; status: 400 | 401 | 404 | 409; message: string };

/**
 * Approve a transfer: the bearer-authenticated old device proves possession of
 * the CURRENT identity private key (fresh signature) AND supplies the E2E-sealed
 * key material. The pending->approved transition is ATOMIC so a concurrent
 * approve cannot double-complete; the loser gets 409.
 *
 * Dual-proof rationale: the bearer alone proves account control but NOT key
 * possession — requiring a fresh signature over the current identity key means a
 * stolen bearer token cannot exfiltrate the private key.
 */
export async function approveDeviceTransfer(
  input: ApproveDeviceTransferInput,
): Promise<ApproveDeviceTransferOutcome> {
  const { pairingId, authenticatedUserId, oldEphPub, ciphertext, nonce, signature, timestamp } = input;

  // Freshness FIRST — reject a stale/replayed signature before any DB work.
  if (Date.now() - timestamp > APPROVAL_SIGNATURE_MAX_AGE_MS) {
    return { ok: false, status: 400, message: 'Approval signature has expired' };
  }

  if (!SignatureService.isValidPublicKey(oldEphPub)) {
    return { ok: false, status: 400, message: 'Invalid ephemeral public key' };
  }

  const db = getDb();

  // Resolve the caller's CURRENT identity public key server-side. Two columns
  // NAMED, never a whole-row read: `users` is in `db/schema/protectedColumns.ts`
  // and a bare `select()` would return the raw phone, the contact-discovery
  // hashes and the refresh token to a public-facing relay.
  const [user] = await db
    .select({ id: users.id, publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, authenticatedUserId))
    .limit(1);
  if (!user) {
    return { ok: false, status: 404, message: 'User not found' };
  }
  if (!user.publicKey) {
    return { ok: false, status: 400, message: 'Account has no identity key to transfer' };
  }

  // Verify the signature proves control of the CURRENT identity key. A bearer
  // token alone must NOT be able to approve a key clone.
  const message = buildApprovalSigningMessage(pairingId, timestamp);
  if (!SignatureService.verifySignature(message, signature, user.publicKey)) {
    return { ok: false, status: 401, message: 'Invalid approval signature' };
  }

  // Pre-flight read for precise error codes (unknown vs expired vs processed).
  const [session] = await db
    .select({
      id: devicePairingSessions.id,
      status: devicePairingSessions.status,
      expiresAt: devicePairingSessions.expiresAt,
    })
    .from(devicePairingSessions)
    .where(eq(devicePairingSessions.pairingId, pairingId))
    .limit(1);
  if (!session) {
    return { ok: false, status: 404, message: 'Pairing not found' };
  }
  if (session.status === 'pending' && session.expiresAt < new Date()) {
    await db
      .update(devicePairingSessions)
      .set({ status: 'expired' })
      .where(
        and(
          eq(devicePairingSessions.id, session.id),
          eq(devicePairingSessions.status, 'pending')
        )
      );
    return { ok: false, status: 400, message: 'Pairing has expired' };
  }
  if (session.status !== 'pending') {
    return { ok: false, status: 409, message: 'Pairing already processed' };
  }

  // ATOMIC pending -> approved. Conditioned on status:'pending' + unexpired so
  // two concurrent approves cannot both win; the loser matches nothing. The
  // deadline is re-tested HERE, in the claiming statement, so the pre-flight
  // read above can never widen the window a pairing is approvable in.
  const [claimed] = await db
    .update(devicePairingSessions)
    .set({
      status: 'approved',
      oldDeviceEphemeralPublicKey: oldEphPub,
      ciphertext,
      nonce,
      approvedByUserId: user.id,
    })
    .where(
      and(
        eq(devicePairingSessions.pairingId, pairingId),
        eq(devicePairingSessions.status, 'pending'),
        gt(devicePairingSessions.expiresAt, sql`now()`)
      )
    )
    .returning({ id: devicePairingSessions.id });

  if (!claimed) {
    return { ok: false, status: 409, message: 'Pairing not found or already processed' };
  }

  logger.info('Device transfer approved', {
    pairingId: pairingId.substring(0, 8) + '...',
    userId: authenticatedUserId,
  });

  return { ok: true, pairingId };
}

/* -------------------------------------------------------------------------- */
/*  deny                                                                       */
/* -------------------------------------------------------------------------- */

export type DenyDeviceTransferOutcome =
  | { ok: true; status: DevicePairingStatus }
  | { ok: false; status: 404 | 409; message: string };

/**
 * Deny (cancel) a pending transfer so the waiting new device stops. Public — the
 * QR-scanning device cancels without a session. Idempotent for an already-denied
 * pairing; refuses to undo an already-approved one.
 */
export async function denyDeviceTransfer(pairingId: string): Promise<DenyDeviceTransferOutcome> {
  const db = getDb();
  const [session] = await db
    .select({ status: devicePairingSessions.status })
    .from(devicePairingSessions)
    .where(eq(devicePairingSessions.pairingId, pairingId))
    .limit(1);
  if (!session) {
    return { ok: false, status: 404, message: 'Pairing not found' };
  }
  if (session.status === 'denied') {
    return { ok: true, status: 'denied' };
  }
  if (session.status !== 'pending') {
    return { ok: false, status: 409, message: `Cannot deny a ${session.status} transfer` };
  }

  const [denied] = await db
    .update(devicePairingSessions)
    .set({ status: 'denied' })
    .where(
      and(
        eq(devicePairingSessions.pairingId, pairingId),
        eq(devicePairingSessions.status, 'pending')
      )
    )
    .returning({ id: devicePairingSessions.id });
  if (!denied) {
    // Lost the race — someone approved/denied concurrently.
    return { ok: false, status: 409, message: 'Pairing already processed' };
  }

  return { ok: true, status: 'denied' };
}
