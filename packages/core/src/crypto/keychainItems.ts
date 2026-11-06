/**
 * The names of every identity item `KeyManager` and `./organizationKeys` keep
 * in `expo-secure-store`, in one place so the access-group migration
 * (`./keychainGroupMigration`) moves exactly what those modules read. Values
 * are stable on-device identifiers: renaming one strands what is stored.
 */

/** Legacy (pre-v2) and shared-slot keys; the legacy ones have no keychain service. */
export const STORAGE_KEYS = {
  PRIVATE_KEY: 'oxy_identity_private_key',
  PUBLIC_KEY: 'oxy_identity_public_key',
  BACKUP_PRIVATE_KEY: 'oxy_identity_backup_private_key',
  BACKUP_PUBLIC_KEY: 'oxy_identity_backup_public_key',
  BACKUP_TIMESTAMP: 'oxy_identity_backup_timestamp',
  // The personal key's cross-app slot: the private key in the wallet group, the
  // public key in the shared group (iOS only), no keychain service.
  SHARED_PRIVATE_KEY: 'oxy_shared_identity_private_key',
  SHARED_PUBLIC_KEY: 'oxy_shared_identity_public_key',
} as const;

export const V2_PRIMARY_KEYCHAIN_SERVICE = 'oxy_identity';
export const V2_BACKUP_KEYCHAIN_SERVICE = 'oxy_identity_backup';

export const V2_STORAGE_KEYS = {
  PRIVATE_KEY: 'oxy_identity_private_key_v2',
  PUBLIC_KEY: 'oxy_identity_public_key_v2',
  BACKUP_PRIVATE_KEY: 'oxy_identity_backup_private_key_v2',
  BACKUP_PUBLIC_KEY: 'oxy_identity_backup_public_key_v2',
  BACKUP_TIMESTAMP: 'oxy_identity_backup_timestamp_v2',
} as const;

export const RECOVERY_MNEMONIC_KEYCHAIN_SERVICE = 'oxy_identity_mnemonic';
export const RECOVERY_MNEMONIC_STORAGE_KEY = 'oxy_identity_mnemonic_v1';

/** Organization keys (ADR 0061 D6). On iOS the pair has no keychain service. */
export const ORGANIZATION_ANDROID_KEYCHAIN_SERVICE = 'oxy_org_identity';
export const ORGANIZATION_MNEMONIC_KEYCHAIN_SERVICE = 'oxy_org_identity_mnemonic';
export const ORGANIZATION_INDEX_KEYCHAIN_SERVICE = 'oxy_org_identity_index';
export const ORGANIZATION_INDEX_STORAGE_KEY = 'oxy_org_identity_index_v1';

export const organizationPrivateKeyName = (accountId: string) =>
  `oxy_org_identity_private_key.${accountId}`;
export const organizationPublicKeyName = (accountId: string) =>
  `oxy_org_identity_public_key.${accountId}`;
export const organizationMnemonicName = (accountId: string) =>
  `oxy_org_identity_mnemonic.${accountId}`;

/** Same set the server's account ids come from: a legacy 24-hex id or a lowercase uuid. */
const ACCOUNT_ID =
  /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Whether `value` is an account id an organization key can be stored under. */
export function isOrganizationAccountId(value: string): boolean {
  return ACCOUNT_ID.test(value);
}

/** The account ids in a stored organization index; anything malformed is skipped. */
export function parseOrganizationIndex(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && isOrganizationAccountId(id))
      : [];
  } catch {
    return [];
  }
}

/** Thrown when Commons' own organization index cannot be read as one: never treated as empty (R5-9). */
export class OrganizationKeyIndexUnreadableError extends Error {
  constructor(reason: string) {
    super(`organization key index: ${reason}`);
    this.name = 'OrganizationKeyIndexUnreadableError';
  }
}

/**
 * Commons' OWN organization index, strictly (R5-9): an index that does not
 * parse, or that holds an entry this version cannot read, THROWS
 * {@link OrganizationKeyIndexUnreadableError}, so no writer overwrites it and
 * drops the organizations it names. `null` is an empty index.
 */
export function parseOrganizationIndexStrict(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OrganizationKeyIndexUnreadableError('the index does not parse');
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((id) => typeof id === 'string' && isOrganizationAccountId(id))
  ) {
    throw new OrganizationKeyIndexUnreadableError(
      'the index holds an entry this version cannot read',
    );
  }
  return parsed as string[];
}

/**
 * The organization a pre-split SECRET item name belongs to: its private key
 * or its phrase (`null` for any other name).
 */
export function organizationOfSecretItem(key: string): string | null {
  for (const prefix of ['oxy_org_identity_private_key.', 'oxy_org_identity_mnemonic.']) {
    if (key.startsWith(prefix)) {
      const accountId = key.slice(prefix.length);
      return isOrganizationAccountId(accountId) ? accountId : null;
    }
  }
  return null;
}

/** The stored form of an organization index: unique, sorted. */
export function serializeOrganizationIndex(ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids)].sort());
}
