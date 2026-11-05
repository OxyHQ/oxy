/**
 * Organization wallets (ADR 0061): the organizations whose identity key this
 * person may create, add or replace, and where this device stands with each.
 *
 * Pure: the screens read the account graph (`oxy.accounts.list`), the
 * organization's key (`oxy.accounts.identityKey.get`) and the key this device
 * holds (`getOrganizationPublicKey`), and ask these functions what to show.
 */
import { IDENTITY_ERROR_CODES, ORGANIZATION_KEY_ERROR_CODES } from '@oxy.so/contracts/client';

/** The roles that may hold and change an organization's key (ADR 0061 D3). */
const GOVERNING_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

export interface GovernableAccount {
  accountId: string;
  kind: string;
  callerMembership: { role: string; status?: string } | null;
}

/** The organizations the signed-in person governs, in the order the graph lists them. */
export function governedOrganizations<T extends GovernableAccount>(accounts: readonly T[]): T[] {
  const seen = new Set<string>();
  return accounts.filter((account) => {
    if (account.kind !== 'organization' || seen.has(account.accountId)) return false;
    const membership = account.callerMembership;
    if (!membership || !GOVERNING_ROLES.has(membership.role)) return false;
    if (membership.status !== undefined && membership.status !== 'active') return false;
    seen.add(account.accountId);
    return true;
  });
}

/**
 * Where this device stands with the organization's key:
 * - `none`: the organization has no key yet ("Set up the organization's Peable wallet");
 * - `held`: this device holds the current key;
 * - `stale`: this device holds a key that is no longer the organization's;
 * - `elsewhere`: the organization has a key and this device does not hold it.
 */
export type DeviceKeyStatus = 'none' | 'held' | 'stale' | 'elsewhere';

export function deviceKeyStatus(
  organizationKey: string | null,
  deviceKey: string | null,
): DeviceKeyStatus {
  const current = organizationKey?.trim().toLowerCase() || null;
  const held = deviceKey?.trim().toLowerCase() || null;
  if (!current) return 'none';
  if (held === current) return 'held';
  return held ? 'stale' : 'elsewhere';
}

/** The translation key for a refusal of the organization-key routes; never the server's English. */
export function organizationKeyErrorKey(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  switch (code) {
    case ORGANIZATION_KEY_ERROR_CODES.forbidden:
      return 'organizationWallet.errors.forbidden';
    case ORGANIZATION_KEY_ERROR_CODES.actorRootRequired:
      return 'organizationWallet.errors.actorRootRequired';
    case ORGANIZATION_KEY_ERROR_CODES.noKey:
    case IDENTITY_ERROR_CODES.rootAlreadyLinked:
      return 'organizationWallet.errors.changed';
    case ORGANIZATION_KEY_ERROR_CODES.keyUsed:
    case IDENTITY_ERROR_CODES.rootLinkedElsewhere:
      return 'organizationWallet.errors.keyUsed';
    case IDENTITY_ERROR_CODES.proofInvalid:
      return 'organizationWallet.errors.proofInvalid';
    default:
      return 'organizationWallet.errors.generic';
  }
}
