/**
 * Silent (non-interactive) identity-key sign-in.
 *
 * The pure core of key sign-in with NO biometric ceremony: resolve the device's
 * public key, then delegate to the SDK's challenge → sign → verify sign-in
 * (`useOxy().signIn`). This is the exact body of {@link useBiometricSignIn} AFTER
 * its biometric gate — extracted so a caller that runs OUTSIDE a user gesture
 * (`useSyncIdentity`, driven from `useNetworkReconnect`'s timer) can reuse it
 * WITHOUT triggering `LocalAuthentication`.
 *
 * Why this matters: a headless `authenticate()` prompt fired with no user in
 * front of it (when `oxy_biometric_enabled === 'true'`) never resolves, hanging
 * the sync forever. Biometrics in Commons gate INTERACTIVE ops (approving
 * another app's sign-in, revealing the recovery phrase), not a background
 * register-and-connect. `useBiometricSignIn` composes the gate + this silent
 * core for the interactive callers (create / import), so its behaviour is
 * unchanged.
 *
 * This is NOT the vault's cold-boot session restore — that belongs to the SDK's
 * `identity-key-signin` step (`sessionMode="identity"`) and must never be
 * re-implemented here.
 */

import { useCallback } from 'react';
import { useOxy } from '@oxy.so/services';
import { KeyManager } from '@oxy.so/core';
import type { User } from '@oxy.so/core';

export interface UseSilentKeySignInResult {
  /**
   * Sign in with the device's identity key WITHOUT any biometric prompt. Resolves
   * the public key (the argument, or `KeyManager.getPublicKey()`) and delegates to
   * the SDK's key sign-in, which is identity-pinned in this app. Every await is
   * HttpService-bounded — it cannot hang.
   */
  signInWithKeySilent: (publicKey?: string, deviceName?: string) => Promise<User>;
}

export function useSilentKeySignIn(): UseSilentKeySignInResult {
  const { signIn: sdkSignIn } = useOxy();

  const signInWithKeySilent = useCallback(
    async (publicKey?: string, deviceName?: string): Promise<User> => {
      const keyToUse = publicKey || (await KeyManager.getPublicKey());
      if (!keyToUse) {
        throw new Error('No identity found on this device');
      }
      if (deviceName) {
        return await sdkSignIn(keyToUse, deviceName);
      }
      return await sdkSignIn(keyToUse);
    },
    [sdkSignIn],
  );

  return { signInWithKeySilent };
}
