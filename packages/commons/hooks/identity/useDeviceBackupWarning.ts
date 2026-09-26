import { useCallback } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyManager } from '@oxy.so/core/crypto';
import {
  probeDeviceBackupAvailability,
  type DeviceBackupAvailability,
} from '@/lib/identity-backup';

/**
 * The "this identity is not backed up on this device" warning (OxyHQ/oxy#1388).
 *
 * Every Oxy Android app shares the UID `so.oxy.shared`, so "Clear storage" on any
 * of them wipes the Keystore that holds the Commons identity. The Block Store
 * device backup restores it silently, but only where Google Play services exist.
 * Where they don't (LineageOS, GrapheneOS without sandboxed Play, Huawei/HMS),
 * or on a binary built before the native module, nothing on the device survives
 * that wipe, and the recovery phrase or the phrase-keyed encrypted backup is the
 * only way back. The warning says so and points at both.
 *
 * It is shown twice over, both non-blocking:
 *   - once, on the ID tab after onboarding, until the user acts on it or taps
 *     "Not now" (`prompted`);
 *   - in Settings, until the user confirms they saved the phrase (`acknowledged`).
 *
 * Both flags hold the PUBLIC KEY they were set for, not `true`: a rotation mints
 * a new phrase, and the old phrase no longer restores anything, so the warning
 * comes back for the new key. They live in AsyncStorage, which is not wrapped by
 * the Keystore, and they are not secrets.
 */

export const DEVICE_BACKUP_WARNING_QUERY_KEY = ['identity', 'device-backup-warning'] as const;

export const NO_DEVICE_BACKUP_PROMPTED_KEY = 'commons.identity.noDeviceBackup.promptedFor';
export const NO_DEVICE_BACKUP_ACKNOWLEDGED_KEY = 'commons.identity.noDeviceBackup.acknowledgedFor';

export interface DeviceBackupWarningSnapshot {
  availability: DeviceBackupAvailability;
  /** This device's identity public key, or `null` when there is none. */
  publicKey: string | null;
  /** Whether a recovery phrase exists for this identity (key imports have none). */
  hasPhrase: boolean;
  promptedFor: string | null;
  acknowledgedFor: string | null;
}

export interface DeviceBackupWarningVerdict {
  /** The Settings banner: until the user confirms. */
  showBanner: boolean;
  /** The one-time banner on the ID tab: until the user acts on it or dismisses it. */
  showPrompt: boolean;
}

const HIDDEN: DeviceBackupWarningVerdict = { showBanner: false, showPrompt: false };

/** Pure: which of the two warnings this snapshot calls for. */
export function deriveDeviceBackupWarning(
  snapshot: DeviceBackupWarningSnapshot | undefined,
): DeviceBackupWarningVerdict {
  if (!snapshot || snapshot.availability !== 'unavailable' || !snapshot.publicKey) {
    return HIDDEN;
  }
  const showBanner = snapshot.acknowledgedFor !== snapshot.publicKey;
  return {
    showBanner,
    showPrompt: showBanner && snapshot.promptedFor !== snapshot.publicKey,
  };
}

async function readFlag(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

async function readHasPhrase(): Promise<boolean> {
  try {
    return Boolean(await KeyManager.getRecoveryMnemonic());
  } catch {
    // A locked keychain cannot confirm absence; assume a phrase exists, as the
    // Backup & recovery hub does, so a phrase-backed user is never told otherwise.
    return true;
  }
}

/** Every input of the verdict. Never throws. */
export async function readDeviceBackupWarningSnapshot(): Promise<DeviceBackupWarningSnapshot> {
  const availability = await probeDeviceBackupAvailability();
  if (availability !== 'unavailable') {
    return { availability, publicKey: null, hasPhrase: true, promptedFor: null, acknowledgedFor: null };
  }
  let publicKey: string | null = null;
  try {
    publicKey = await KeyManager.getPublicKey();
  } catch {
    publicKey = null;
  }
  const [hasPhrase, promptedFor, acknowledgedFor] = await Promise.all([
    readHasPhrase(),
    readFlag(NO_DEVICE_BACKUP_PROMPTED_KEY),
    readFlag(NO_DEVICE_BACKUP_ACKNOWLEDGED_KEY),
  ]);
  return { availability, publicKey, hasPhrase, promptedFor, acknowledgedFor };
}

export interface DeviceBackupWarning extends DeviceBackupWarningVerdict {
  hasPhrase: boolean;
  /** Retire the one-time ID-tab banner for this key. */
  markPrompted: () => Promise<void>;
  /** The user confirmed they saved the phrase: retire both banners for this key. */
  acknowledge: () => Promise<void>;
}

/**
 * The warning's state for the current identity. Android only; everywhere else
 * both banners stay hidden without probing anything. The root layout invalidates
 * {@link DEVICE_BACKUP_WARNING_QUERY_KEY} on every identity change.
 */
export function useDeviceBackupWarning(): DeviceBackupWarning {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: DEVICE_BACKUP_WARNING_QUERY_KEY,
    queryFn: readDeviceBackupWarningSnapshot,
    enabled: Platform.OS === 'android',
    staleTime: Infinity,
    retry: false,
  });
  const snapshot = query.data;

  const persist = useCallback(
    async (acknowledged: boolean) => {
      const publicKey = snapshot?.publicKey;
      if (!publicKey) return;
      // Hide first: the banner goes the moment it is tapped, even if the write
      // fails (the worst case is that it shows again on the next launch).
      queryClient.setQueryData<DeviceBackupWarningSnapshot>(DEVICE_BACKUP_WARNING_QUERY_KEY, (prev) =>
        prev
          ? {
              ...prev,
              promptedFor: publicKey,
              acknowledgedFor: acknowledged ? publicKey : prev.acknowledgedFor,
            }
          : prev,
      );
      // Confirming in Settings also retires the one-time ID-tab banner.
      const keys = acknowledged
        ? [NO_DEVICE_BACKUP_PROMPTED_KEY, NO_DEVICE_BACKUP_ACKNOWLEDGED_KEY]
        : [NO_DEVICE_BACKUP_PROMPTED_KEY];
      try {
        await Promise.all(keys.map((key) => AsyncStorage.setItem(key, publicKey)));
      } catch (error) {
        console.warn('[identity] could not persist the device-backup warning state', error);
      }
    },
    [queryClient, snapshot?.publicKey],
  );

  const markPrompted = useCallback(() => persist(false), [persist]);
  const acknowledge = useCallback(() => persist(true), [persist]);

  return {
    ...deriveDeviceBackupWarning(snapshot),
    hasPhrase: snapshot?.hasPhrase ?? true,
    markPrompted,
    acknowledge,
  };
}
