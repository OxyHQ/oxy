/**
 * Encrypted off-device identity backup mixin (b3 Feature 1).
 *
 * Lets a self-custody identity store an ENCRYPTED copy of its key off-device so
 * a lost/wiped device can be recovered from the recovery phrase alone — while the
 * platform never sees the phrase, the derived key, or the plaintext private key.
 *
 * Key schedule (from the recovery phrase; see
 * {@link RecoveryPhraseService.deriveBackupMaterial}):
 *   seed      = mnemonicToSeed(phrase)                          // 64 bytes, UNCHANGED
 *   backupKey = HKDF(seed, 'oxy-identity-backup-v1', 'oxy-backup-encryption-key')
 *   lookupId  = HKDF(seed, 'oxy-identity-backup-v1', 'oxy-backup-lookup-id')   // hex
 *
 * The two derivations require the FULL seed, so a device compromise that leaks
 * only the raw 32-byte private key can neither locate nor decrypt the backup.
 *
 * Wire shapes come from `@oxyhq/contracts` (`EncryptedBackupEnvelope`,
 * `BackupUploadRequest`, `BackupStatusResponse`) — the API validates its
 * request/response against the same schemas, so producer and consumer cannot
 * drift.
 *
 * Encryption/derivation are cross-platform (pure `@noble/*`), but persisting a
 * restored key is NATIVE-ONLY: `restoreFromEncryptedBackup` ends in
 * `KeyManager.importKeyPair`, which throws on web (SecureStore does not exist
 * there) — decryption still succeeds, only the local write is native-only.
 */
import type {
  BackupStatusResponse,
  BackupUploadRequest,
  EncryptedBackupEnvelope,
} from '@oxyhq/contracts';
import type { OxyServicesBase } from '../OxyServices.base';
import { KeyManager, IdentityAlreadyExistsError } from '../crypto/keyManager';
import { RecoveryPhraseService, BACKUP_KDF_ENCRYPTION_INFO } from '../crypto/recoveryPhrase';
import { encryptAead, decryptAead } from '../crypto/aead';

/** Envelope/KDF version — bump only on a breaking scheme change. */
const BACKUP_ENVELOPE_VERSION = 1;
/** The AEAD the backup is sealed with. Pinned so a mismatched decryptor fails loudly. */
const BACKUP_ALGORITHM = 'xchacha20poly1305' as const;
/**
 * Length (hex chars) of the public-key HINT stored/echoed with a backup — enough
 * to let the owner recognise WHICH identity a backup belongs to, but only a
 * prefix (the full key is public anyway; a prefix keeps the record minimal).
 */
const PUBLIC_KEY_HINT_LENGTH = 16;

/** The decrypted backup payload. */
interface BackupPayload {
  privateKey: string;
  publicKey: string;
  createdAt: string;
}

/** Encode bytes as lowercase hex (cross-platform, no Buffer dependency). */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Decode a lowercase/uppercase hex string to bytes. Throws on malformed input. */
function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('Malformed hex in encrypted backup envelope.');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * The AEAD associated data binds the ciphertext to its `{version, publicKeyHint}`
 * context: the exact bytes must be reproduced at decrypt time, so a mismatched
 * version or hint (e.g. an envelope re-stamped by a tamperer) fails the
 * Poly1305 check. Deterministic: both sides build the SAME object literal, so
 * `JSON.stringify` yields identical bytes.
 */
function buildBackupAad(version: number, publicKeyHint: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version, publicKeyHint }));
}

export function OxyServicesIdentityBackupMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    /**
     * Derive the backup key material from the recovery phrase, encrypt the
     * identity's `{privateKey, publicKey, createdAt}` with it, and upload the
     * ciphertext + raw `lookupId` (`POST /identity/backup`, bearer). The server
     * stores only `sha256(lookupId)` + the ciphertext. Idempotent per user: a
     * re-upload REPLACES the prior backup (upsert by user id).
     *
     * The identity is derived from the PHRASE (not read from SecureStore), so
     * this works cross-platform and does not require an on-device key.
     *
     * @param phrase - The identity's BIP-39 recovery phrase.
     * @returns The post-write backup status (`{ exists: true, publicKeyHint, createdAt }`).
     */
    async createEncryptedBackup(phrase: string): Promise<BackupStatusResponse> {
      try {
        const { backupKey, lookupId } = await RecoveryPhraseService.deriveBackupMaterial(phrase);
        const privateKey = await RecoveryPhraseService.derivePrivateKeyFromPhrase(phrase);
        const publicKey = KeyManager.derivePublicKey(privateKey);
        const createdAt = new Date().toISOString();
        const publicKeyHint = publicKey.slice(0, PUBLIC_KEY_HINT_LENGTH);

        const payload: BackupPayload = { privateKey, publicKey, createdAt };
        const plaintext = new TextEncoder().encode(JSON.stringify(payload));
        const aad = buildBackupAad(BACKUP_ENVELOPE_VERSION, publicKeyHint);
        const { nonce, ciphertext } = encryptAead(backupKey, plaintext, aad);

        const body: BackupUploadRequest = {
          version: BACKUP_ENVELOPE_VERSION,
          algorithm: BACKUP_ALGORITHM,
          kdfInfo: BACKUP_KDF_ENCRYPTION_INFO,
          nonce: toHex(nonce),
          ciphertext: toHex(ciphertext),
          publicKeyHint,
          createdAt,
          lookupId,
        };

        return await this.makeRequest<BackupStatusResponse>(
          'POST',
          '/identity/backup',
          body,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Whether the authenticated user has a stored encrypted backup, plus the
     * non-sensitive hint + timestamp when one exists (`GET /identity/backup/status`,
     * bearer). Returns no ciphertext and no locator.
     */
    async getBackupStatus(): Promise<BackupStatusResponse> {
      try {
        return await this.makeRequest<BackupStatusResponse>(
          'GET',
          '/identity/backup/status',
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Delete the authenticated user's stored backup (`DELETE /identity/backup`,
     * bearer). Idempotent — deleting a non-existent backup still succeeds.
     */
    async deleteBackup(): Promise<{ success: boolean }> {
      try {
        return await this.makeRequest<{ success: boolean }>(
          'DELETE',
          '/identity/backup',
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Restore an identity from its encrypted off-device backup using ONLY the
     * recovery phrase: re-derive `{backupKey, lookupId}`, fetch the envelope by
     * `lookupId` (`GET /identity/backup/:lookupId`, PUBLIC — the 256-bit locator
     * is the protection), decrypt + authenticate locally, then persist the key.
     *
     * NATIVE-ONLY persistence: `KeyManager.importKeyPair` throws on web. It also
     * refuses to clobber a DIFFERENT existing on-device identity unless
     * `overwrite: true` — the {@link import('../crypto/keyManager').IdentityAlreadyExistsError}
     * propagates to the caller (never swallowed) so the UI can confirm before
     * overwriting.
     *
     * @param phrase - The identity's BIP-39 recovery phrase.
     * @param options.overwrite - Replace a different existing on-device identity.
     * @returns The restored identity's public key.
     * @throws if the phrase is invalid, no backup exists (404), the ciphertext
     *   fails authentication (tamper), or an existing identity blocks the import.
     */
    async restoreFromEncryptedBackup(
      phrase: string,
      options?: { overwrite?: boolean },
    ): Promise<string> {
      try {
        const { backupKey, lookupId } = await RecoveryPhraseService.deriveBackupMaterial(phrase);

        const envelope = await this.makeRequest<EncryptedBackupEnvelope>(
          'GET',
          `/identity/backup/${encodeURIComponent(lookupId)}`,
          undefined,
          { cache: false },
        );

        if (envelope.algorithm !== BACKUP_ALGORITHM) {
          throw new Error(`Unsupported backup algorithm: ${envelope.algorithm}`);
        }

        const aad = buildBackupAad(envelope.version, envelope.publicKeyHint);
        const plaintext = decryptAead(
          backupKey,
          fromHex(envelope.nonce),
          fromHex(envelope.ciphertext),
          aad,
        );
        const payload = JSON.parse(new TextDecoder().decode(plaintext)) as BackupPayload;

        if (!payload.privateKey || !payload.publicKey) {
          throw new Error('Backup payload is missing key material');
        }

        const derivedFromPhrase = await RecoveryPhraseService.derivePublicKeyFromPhrase(phrase);
        const derivedFromPrivate = KeyManager.derivePublicKey(payload.privateKey);
        const phrasePk = derivedFromPhrase.toLowerCase();
        const payloadPk = payload.publicKey.toLowerCase();
        const privatePk = derivedFromPrivate.toLowerCase();
        if (phrasePk !== payloadPk || privatePk !== payloadPk) {
          throw new Error('Backup payload does not match the recovery phrase');
        }

        // Persist the recovered key. Native-only; refuses to clobber a different
        // identity unless overwrite — the IdentityAlreadyExistsError propagates.
        return await KeyManager.importKeyPair(payload.privateKey, {
          overwrite: options?.overwrite === true,
        });
      } catch (error) {
        // Preserve the typed "an identity already exists" signal so the caller
        // can prompt for overwrite. `handleError` would flatten it to a generic
        // Error and lose that discrimination.
        if (error instanceof IdentityAlreadyExistsError) {
          throw error;
        }
        throw this.handleError(error);
      }
    }
  };
}
