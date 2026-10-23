/**
 * What a returning session needs for its first paint, kept on this device.
 *
 * A cold boot used to wait on two round trips before it showed anything: the
 * registry's classification of this app and the profile of the signed-in
 * account. With a session saved on the device, the app now paints at once from
 * what the last run left here, and the boot verifies both in the background
 * (`runProviderColdBoot`). This module is that cache:
 *
 * - the registry's last verdict on this app (`device` or `oauth`), tied to the
 *   `clientId` it was given for;
 * - the last account profile the runtime held, tied to that account's id.
 *
 * Both live in the provider's ordinary storage (AsyncStorage on native,
 * `localStorage` on web), next to the per-account query cache, which already
 * holds the same profile under the SDK's `users` queries. Neither is a
 * credential: the device secret and the access token stay in the auth store.
 *
 * A cached session is offered only when it matches the auth store: the profile
 * must belong to the account the persisted session is for, so a switch or a
 * sign-out on a previous run can never paint somebody else.
 */
import type { User } from '@oxy.so/core';
import { TOKEN_REFRESH_LEAD_MS, type AuthStateStore } from '@oxy.so/core/session';
import type { StorageInterface } from '../utils/storageHelpers';

export type SessionLane = 'device' | 'oauth';

/** A persisted session the app can show before the network answers. */
export interface CachedSession {
  sessionId: string;
  userId: string;
  deviceId: string;
  /** The account profile the last run held for {@link userId}. */
  user: User;
  /** The persisted access token, when it is still valid past the refresh lead. */
  warmToken: string | null;
}

export interface CachedBootStore {
  saveLane(clientId: string, lane: SessionLane): Promise<void>;
  saveAccount(user: User): Promise<void>;
  clearAccount(): Promise<void>;
  /**
   * The cached session for this `clientId`, or `null` when anything a first
   * paint needs is missing or does not match the auth store.
   */
  readSession(clientId: string, authStore: AuthStateStore): Promise<CachedSession | null>;
}

const SCHEMA_VERSION = 1;

function parse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isUser(value: unknown): value is User {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.length > 0
  );
}

export function createCachedBootStore(
  storage: StorageInterface,
  prefix: string,
  now: () => number = Date.now,
): CachedBootStore {
  const laneKey = `${prefix}_boot_lane`;
  const accountKey = `${prefix}_boot_account`;
  // Storage failures are never fatal here: a missing entry only means the next
  // boot waits for the network, as every boot did before this cache existed.
  const write = (key: string, value: unknown) =>
    storage.setItem(key, JSON.stringify({ v: SCHEMA_VERSION, ...(value as object) })).catch(() => {
      /* best effort */
    });

  return {
    saveLane: (clientId, lane) => write(laneKey, { clientId, lane }),
    saveAccount: (user) => write(accountKey, { user }),
    clearAccount: () =>
      storage.removeItem(accountKey).catch(() => {
        /* best effort */
      }),

    async readSession(clientId, authStore) {
      const [laneEntry, accountEntry] = await Promise.all([
        storage.getItem(laneKey).then(parse, () => null),
        storage.getItem(accountKey).then(parse, () => null),
      ]);
      if (
        laneEntry?.v !== SCHEMA_VERSION ||
        laneEntry.clientId !== clientId ||
        laneEntry.lane !== 'device'
      ) {
        return null;
      }
      const user = accountEntry?.v === SCHEMA_VERSION ? accountEntry.user : null;
      if (!isUser(user)) return null;

      const persisted = await authStore.load();
      // Only the app's OWN holder: the background check mints with it, which is
      // the only way the server can confirm or end this session.
      if (
        !persisted?.sessionId ||
        !persisted.deviceId ||
        !persisted.deviceSecret ||
        persisted.userId !== user.id
      ) {
        return null;
      }
      // A recorded sign-out on this device restores nothing automatically.
      if (await authStore.isAutomaticIdentitySignInSuppressed?.()) return null;

      const expiresAtMs = persisted.expiresAt ? new Date(persisted.expiresAt).getTime() : NaN;
      const warmToken =
        persisted.accessToken &&
        Number.isFinite(expiresAtMs) &&
        expiresAtMs > now() + TOKEN_REFRESH_LEAD_MS
          ? persisted.accessToken
          : null;
      return {
        sessionId: persisted.sessionId,
        userId: persisted.userId,
        deviceId: persisted.deviceId,
        user,
        warmToken,
      };
    },
  };
}
