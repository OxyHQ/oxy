/**
 * Device-to-device Identity Transfer Mixin (b3 Feature 2 — "add a device")
 *
 * Clones an existing device's secp256k1 identity onto a fresh device over a
 * short-lived, unauthenticated relay, WITHOUT the server ever holding a
 * decryption key. Both devices end up holding the SAME private key.
 *
 * The two devices agree on a symmetric key via an ephemeral secp256k1 ECDH
 * handshake (Phase-0 crypto): `deriveSharedSecret` → `hkdfSha256` → a per-pairing
 * transfer key, used with `encryptAead`/`decryptAead` (XChaCha20-Poly1305) to
 * seal `{ privateKey, publicKey }`. The relay carries only ephemeral public keys
 * plus opaque ciphertext — a passive/at-rest-compromised backend cannot decrypt.
 *
 * Roles:
 *  - NEW device (no identity): {@link initDeviceTransfer} (generate ephemeral
 *    pair, register the pairing, render `pairingId` as a QR) then
 *    {@link subscribeDeviceTransfer} (await approval over the `/device-pair`
 *    socket with a poll fallback, decrypt, and import the key).
 *  - OLD device (has identity): {@link getDeviceTransferInfo} (resolve the
 *    scanned `pairingId` server-side — the QR is NOT self-contained) then
 *    {@link approveDeviceTransfer} (biometric-gate in the UI, seal the key
 *    material, and post it with a fresh signature over the CURRENT identity key).
 *
 * SECURITY: E2E against a passive relay only. Explicitly NOT hardened against an
 * actively-malicious backend MITM'ing the ephemeral keys (same trust boundary as
 * the existing QR sign-in; SAS compare deferred per owner decision). Approve
 * requires BOTH a bearer token AND a fresh identity-key signature.
 */

import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@noble/hashes/utils';
import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import type { OxyServicesBase } from '../OxyServices.base';
import type {
  DeviceTransferInfoResponse,
  DeviceTransferInitResponse,
  DeviceTransferApproveResponse,
  DeviceTransferDenyResponse,
} from '@oxyhq/contracts';
import { deriveSharedSecret } from '../crypto/ecdh';
import { hkdfSha256 } from '../crypto/kdf';
import { encryptAead, decryptAead } from '../crypto/aead';
import { KeyManager } from '../crypto/keyManager';
import { SignatureService } from '../crypto/signatureService';
import { getSocketIO } from '../session/socketLoader';
import type { MinimalSocket } from '../session/socketLoader';
import { logger } from '../logger';

/**
 * Ephemeral private keys for pairings an instance INITIATED, keyed by pairingId,
 * held per OxyServices instance. In-memory ONLY (never persisted — single-use),
 * cleared once the transfer settles. A module-level WeakMap (rather than a class
 * field) keeps it off the mixin's emitted `.d.ts` (avoids TS4094 on the exported
 * anonymous class) and lets the GC drop it with the instance.
 */
const ephemeralKeyStore = new WeakMap<object, Map<string, string>>();

function getEphemeralKeys(instance: object): Map<string, string> {
  let keys = ephemeralKeyStore.get(instance);
  if (!keys) {
    keys = new Map<string, string>();
    ephemeralKeyStore.set(instance, keys);
  }
  return keys;
}

/** HKDF `info` binding — MUST match the server/other-device byte-for-byte. */
const DEVICE_TRANSFER_HKDF_INFO = 'oxy-device-transfer-v1';
/** Socket.IO namespace the API pushes device-pair approval events on. */
const DEVICE_PAIR_NAMESPACE = '/device-pair';
/** Fallback poll cadence — the socket delivers approval instantly; this covers
 *  the case where the socket can't connect. */
const DEVICE_TRANSFER_POLL_INTERVAL_MS = 2500;
/** Action string signed on approve (mirrors `link_identity`'s scheme). */
const DEVICE_TRANSFER_APPROVE_ACTION = 'approve_device_transfer';

/** Result of {@link OxyServicesDeviceTransferMixin.initDeviceTransfer}. */
export interface InitDeviceTransferResult {
  /** 128-bit single-use handle to render in the QR (also the HKDF salt). */
  pairingId: string;
  /** ISO-8601 expiry (3 minutes). */
  expiresAt: string;
  /** The new device's ephemeral public key registered with the relay. */
  newEphemeralPublicKey: string;
}

/** Terminal outcome delivered to {@link subscribeDeviceTransfer}'s callback. */
export type DeviceTransferOutcome =
  | { status: 'approved'; publicKey: string }
  | { status: 'denied' }
  | { status: 'expired' };

/**
 * Derive the per-pairing symmetric transfer key from an ECDH shared secret.
 * Identical on both devices: `HKDF(ECDH, salt=pairingId, info=v1)`.
 */
function deriveTransferKey(sharedSecret: Uint8Array, pairingId: string): Uint8Array {
  return hkdfSha256(
    sharedSecret,
    utf8ToBytes(pairingId),
    utf8ToBytes(DEVICE_TRANSFER_HKDF_INFO),
    32,
  );
}

export function OxyServicesDeviceTransferMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    /**
     * NEW device — begin an "add a device" transfer. Generates a single-use
     * ephemeral secp256k1 pair, registers the pairing, and returns the
     * `pairingId` to render as a QR. The ephemeral private key is held in memory
     * (keyed by `pairingId`) for the subsequent {@link subscribeDeviceTransfer}.
     *
     * @param label - Optional human-readable label for this new device.
     */
    async initDeviceTransfer(label?: string): Promise<InitDeviceTransferResult> {
      try {
        const { privateKey: ephPrivateKey, publicKey: ephPublicKey } =
          generateSecp256k1KeyPair();

        const res = await this.makeRequest<DeviceTransferInitResponse>(
          'POST',
          '/identity/device-transfer/init',
          { newEphPub: ephPublicKey, ...(label ? { newDeviceLabel: label } : {}) },
          { cache: false },
        );

        getEphemeralKeys(this).set(res.pairingId, ephPrivateKey);
        return {
          pairingId: res.pairingId,
          expiresAt: res.expiresAt,
          newEphemeralPublicKey: ephPublicKey,
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Resolve a pairing server-side (the QR carries only `pairingId`). The OLD
     * device calls this after scanning to read the new device's ephemeral public
     * key + label; the NEW device polls it to fetch the sealed material once
     * approved. Public — no auth required.
     */
    async getDeviceTransferInfo(pairingId: string): Promise<DeviceTransferInfoResponse> {
      try {
        return await this.makeRequest<DeviceTransferInfoResponse>(
          'GET',
          `/identity/device-transfer/${encodeURIComponent(pairingId)}`,
          undefined,
          { cache: false, retry: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * OLD device — approve a scanned transfer. Reads the new device's ephemeral
     * public key, derives the shared transfer key, AEAD-seals
     * `{ privateKey, publicKey }`, and posts it PLUS a fresh signature over
     * `{ action:'approve_device_transfer', pairingId, timestamp }` made with the
     * CURRENT identity key (dual-proof alongside the bearer token).
     *
     * NATIVE-ONLY: requires a stored identity (throws otherwise). The UI must
     * biometric-gate before calling this — a key clone leaves the device.
     */
    async approveDeviceTransfer(pairingId: string): Promise<DeviceTransferApproveResponse> {
      try {
        const info = await this.getDeviceTransferInfo(pairingId);
        if (info.status !== 'pending') {
          throw new Error(`This transfer can no longer be approved (status: ${info.status}).`);
        }

        const privateKey = await KeyManager.getPrivateKey();
        const publicKey = await KeyManager.getPublicKey();
        if (!privateKey || !publicKey) {
          throw new Error('No identity found on this device. Create or import an identity first.');
        }

        // Ephemeral ECDH → per-pairing transfer key.
        const { privateKey: oldEphPrivateKey, publicKey: oldEphPublicKey } =
          generateSecp256k1KeyPair();

        const sharedSecret = deriveSharedSecret(oldEphPrivateKey, info.newDeviceEphemeralPublicKey);
        const transferKey = deriveTransferKey(sharedSecret, pairingId);

        // Seal the identity key material.
        const plaintext = utf8ToBytes(JSON.stringify({ privateKey, publicKey }));
        const { nonce, ciphertext } = encryptAead(transferKey, plaintext);

        // Dual-proof: prove control of the CURRENT identity key (a bearer alone
        // must not be able to exfiltrate the private key).
        const timestamp = Date.now();
        const message = JSON.stringify({
          action: DEVICE_TRANSFER_APPROVE_ACTION,
          pairingId,
          timestamp,
        });
        const signature = await SignatureService.sign(message);

        return await this.makeRequest<DeviceTransferApproveResponse>(
          'POST',
          `/identity/device-transfer/${encodeURIComponent(pairingId)}/approve`,
          {
            oldEphPub: oldEphPublicKey,
            ciphertext: bytesToHex(ciphertext),
            nonce: bytesToHex(nonce),
            signature,
            timestamp,
          },
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * OLD device — deny (cancel) a scanned transfer so the waiting new device
     * stops. Public — no auth required.
     */
    async denyDeviceTransfer(pairingId: string): Promise<DeviceTransferDenyResponse> {
      try {
        return await this.makeRequest<DeviceTransferDenyResponse>(
          'POST',
          `/identity/device-transfer/${encodeURIComponent(pairingId)}/deny`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * NEW device — await approval for a pairing started with
     * {@link initDeviceTransfer}, then decrypt and import the transferred
     * identity key. Primary path is an instant `device_pair_update` push over the
     * `/device-pair` socket; a poll backstops a socket that can't connect.
     *
     * On `approved`: re-derives the shared transfer key from the old device's
     * ephemeral public key, decrypts `{ privateKey, publicKey }`, imports it via
     * `KeyManager.importKeyPair(privateKey, { overwrite: false })`, and invokes
     * `onOutcome({ status:'approved', publicKey })`. The caller then runs the
     * NORMAL challenge/verify sign-in — this method does not mint a session.
     *
     * @returns An unsubscribe function; call it to stop waiting (also called
     *   automatically once the transfer settles).
     */
    subscribeDeviceTransfer(
      pairingId: string,
      onOutcome: (outcome: DeviceTransferOutcome) => void,
    ): () => void {
      const ephemeralKeys = getEphemeralKeys(this);
      const ephPrivateKey = ephemeralKeys.get(pairingId);
      if (!ephPrivateKey) {
        throw new Error(
          'No pending device transfer for this pairing id. Call initDeviceTransfer first.',
        );
      }

      let settled = false;
      let inFlight = false;
      let socket: MinimalSocket | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = (): void => {
        if (pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        if (socket) {
          try {
            socket.off('device_pair_update');
            socket.off('connect');
            socket.disconnect();
          } catch (error) {
            logger.debug('[DeviceTransfer] socket close failed', { component: 'DeviceTransfer' }, error);
          }
          socket = null;
        }
        ephemeralKeys.delete(pairingId);
      };

      const finish = (outcome: DeviceTransferOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        onOutcome(outcome);
      };

      // Re-check authoritative status; on `approved`, decrypt + import.
      const check = async (): Promise<void> => {
        if (settled || inFlight) return;
        inFlight = true;
        try {
          const info = await this.getDeviceTransferInfo(pairingId);
          if (settled) return;

          if (info.status === 'denied') {
            finish({ status: 'denied' });
            return;
          }
          if (info.status === 'expired') {
            finish({ status: 'expired' });
            return;
          }
          if (
            info.status === 'approved' &&
            info.oldDeviceEphemeralPublicKey &&
            info.ciphertext &&
            info.nonce
          ) {
            const sharedSecret = deriveSharedSecret(
              ephPrivateKey,
              info.oldDeviceEphemeralPublicKey,
            );
            const transferKey = deriveTransferKey(sharedSecret, pairingId);
            const plaintext = decryptAead(
              transferKey,
              hexToBytes(info.nonce),
              hexToBytes(info.ciphertext),
            );
            const parsed = JSON.parse(bytesToUtf8(plaintext)) as {
              privateKey: string;
              publicKey: string;
            };
            // Import WITHOUT overwrite: a fresh device has no identity, and we
            // must never silently clobber an existing one.
            const importedPublicKey = await KeyManager.importKeyPair(parsed.privateKey, {
              overwrite: false,
            });
            finish({ status: 'approved', publicKey: importedPublicKey });
          }
        } catch (error) {
          // Transient (a poll tick that raced the approve write, a decrypt on a
          // half-written row) — keep waiting; the next tick/push retries.
          logger.debug('[DeviceTransfer] status check failed', { component: 'DeviceTransfer' }, error);
        } finally {
          inFlight = false;
        }
      };

      // Primary: instant socket wake. Fall back to polling if unavailable.
      void (async () => {
        const io = await getSocketIO();
        if (settled || !io) return;
        try {
          const s = io(`${this.getBaseURL()}${DEVICE_PAIR_NAMESPACE}`, {
            transports: ['websocket'],
            autoConnect: true,
            reconnection: true,
            reconnectionAttempts: Number.POSITIVE_INFINITY,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 10000,
          });
          const join = (): void => {
            try {
              s.emit('join', pairingId);
            } catch (error) {
              logger.debug('[DeviceTransfer] join failed', { component: 'DeviceTransfer' }, error);
            }
          };
          s.on('connect', join);
          if (s.connected) join();
          s.on('device_pair_update', () => {
            void check();
          });
          socket = s;
        } catch (error) {
          logger.debug('[DeviceTransfer] socket create failed (poll fallback)', { component: 'DeviceTransfer' }, error);
        }
      })();

      // Fallback poll (also covers the already-approved-before-subscribe case via
      // the immediate first tick below). unref so it never holds a Node event
      // loop / test runner open.
      pollTimer = setInterval(() => {
        void check();
      }, DEVICE_TRANSFER_POLL_INTERVAL_MS);
      (pollTimer as { unref?: () => void }).unref?.();

      // Immediate first check — the transfer may already be approved/denied.
      void check();

      return cleanup;
    }
  };
}
