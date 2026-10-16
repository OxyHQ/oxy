/**
 * iOS and Android: the app proves itself with App Attest or Play Integrity
 * through `@expo/app-integrity` (ADR 0045).
 *
 * The module is loaded lazily, and its `import()` is a direct statement of a
 * `try` block — the shape Metro marks OPTIONAL — so an app bundle that lacks
 * the package, or a binary built before it was added (an over-the-air update
 * of the JavaScript alone), still boots: `requireNativeModule` throws inside
 * the import, and the app simply has no assertion.
 */
import { Platform } from 'react-native';
import type { AppIntegrityModule, AppIntegrityPlatform } from './appIntegrityTypes';

async function loadIntegrity(): Promise<AppIntegrityModule | null> {
  try {
    const integrity = await import('@expo/app-integrity');
    return integrity;
  } catch {
    return null;
  }
}

export const appIntegrityPlatform: AppIntegrityPlatform = {
  platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
  loadIntegrity:
    Platform.OS === 'ios' || Platform.OS === 'android' ? loadIntegrity : async () => null,
};
