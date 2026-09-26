/**
 * The device backup of the self-custody identity: a copy that lives OUTSIDE this
 * app's own keystore, so a keystore wipe cannot take it along with the keys.
 *
 * Why it exists (OxyHQ/oxy#1388): on Android every Oxy app shares the Linux UID
 * `so.oxy.shared`, and the Android Keystore is per UID. Clearing the storage of
 * ANY sibling app (`pm clear`, or Settings › Apps › Storage › Clear storage)
 * wipes the Keystore of the whole UID. Every copy the SDK keeps in
 * expo-secure-store (primary, backup slot, phrase slot) and in the androidx
 * encrypted prefs (the cross-app shared slot) is wrapped by a key in that
 * Keystore, so they all die together, and until now the only way back was the
 * recovery phrase.
 *
 * `@oxy.so/core` never imports a native module, so the store is injected by the
 * app that owns the identity ({@link KeyManager.setDeviceBackupStore}). Commons
 * registers Android Block Store; every other app registers nothing, which keeps
 * every code path below a no-op for them. The design and the threat model are in
 * `docs/identity/device-backup.md`.
 */

/**
 * Where the device backup is kept. Implementations must hold the value outside
 * the calling app's keystore (that is the whole point) and must never send it
 * anywhere Oxy can read it.
 *
 * `read` resolves `null` when nothing is stored AND when the store cannot be
 * reached (no Google Play services, an old binary without the native module):
 * the caller treats both as "no device backup" and falls back to the phrase.
 */
export interface IdentityDeviceBackupStore {
  /** Short name for logs, e.g. `android-block-store`. Never contains secrets. */
  readonly name: string;
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

/** The record format. Bump {@link DEVICE_BACKUP_VERSION} on a breaking change. */
export const DEVICE_BACKUP_VERSION = 1;

export interface DeviceBackupRecord {
  version: typeof DEVICE_BACKUP_VERSION;
  /** Canonical lowercase 64-hex secp256k1 private key. */
  privateKey: string;
  /** Canonical lowercase public key. */
  publicKey: string;
  /**
   * The BIP-39 phrase, present only when it was verified to derive
   * {@link publicKey}. Carried so a restored identity can still reveal its
   * phrase in Settings and create the phrase-keyed Oxy backup; the phrase is
   * never more powerful than the private key already in the record.
   */
  mnemonic?: string;
  /** ISO-8601 time of the last write. */
  updatedAt: string;
}

export function serializeDeviceBackup(record: DeviceBackupRecord): string {
  const out: DeviceBackupRecord = {
    version: DEVICE_BACKUP_VERSION,
    privateKey: record.privateKey,
    publicKey: record.publicKey,
    updatedAt: record.updatedAt,
  };
  if (record.mnemonic) {
    out.mnemonic = record.mnemonic;
  }
  return JSON.stringify(out);
}

/**
 * Parse a stored record, or `null` for anything that is not a well-formed
 * version-1 record. Checks SHAPE only; the caller still proves the key pair is
 * healthy (well-formed, public derives from private) before trusting it.
 */
export function parseDeviceBackup(raw: string | null | undefined): DeviceBackupRecord | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== DEVICE_BACKUP_VERSION ||
    typeof candidate.privateKey !== 'string' ||
    typeof candidate.publicKey !== 'string' ||
    typeof candidate.updatedAt !== 'string'
  ) {
    return null;
  }
  const record: DeviceBackupRecord = {
    version: DEVICE_BACKUP_VERSION,
    privateKey: candidate.privateKey,
    publicKey: candidate.publicKey,
    updatedAt: candidate.updatedAt,
  };
  if (typeof candidate.mnemonic === 'string' && candidate.mnemonic.length > 0) {
    record.mnemonic = candidate.mnemonic;
  }
  return record;
}
