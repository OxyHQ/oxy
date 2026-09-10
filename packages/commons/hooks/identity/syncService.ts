import { isInvalidSessionError } from '@oxy.so/services';
import { KeyManager, SignatureService } from '@oxy.so/core';
import type { User, OxyServices } from '@oxy.so/core';
import { isAlreadyRegisteredError } from './identityErrors';

export interface SyncServiceOptions {
  /** OxyServices instance */
  oxyServices: OxyServices;
  /** Sign in function (with biometric support) */
  signIn: (publicKey: string) => Promise<User>;
  /** Whether identity is already synced (from caller's state management) */
  isAlreadySynced: boolean;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Optional callback when sync flag needs to be cleared (for expired session) */
  onSessionExpired?: () => Promise<void>;
}

export interface SyncServiceResult {
  /** The authenticated user */
  user: User;
  /** Whether identity was newly registered */
  wasRegistered: boolean;
}

// Error type detection helpers
const isUserNotFoundError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('User not found') || message.includes('Please register first');
};

/**
 * Attempt to sign in if identity is already synced.
 * Returns null if sign-in fails or identity needs registration.
 */
const attemptSignIn = async (
  isAlreadySynced: boolean,
  signIn: (publicKey: string) => Promise<User>,
  publicKey: string,
  onSessionExpired?: () => Promise<void>
): Promise<User | null> => {
  if (!isAlreadySynced) return null;

  try {
    return await signIn(publicKey);
  } catch (error: unknown) {
    // Session expired - clear sync state and retry registration flow
    if (isInvalidSessionError(error)) {
      await onSessionExpired?.();
      return null;
    }
    // User not found on server - need to register
    if (isUserNotFoundError(error)) {
      await onSessionExpired?.();
      return null;
    }
    throw error;
  }
};

/**
 * Check if public key is registered on the server.
 */
const checkRegistration = async (
  oxyServices: OxyServices,
  publicKey: string,
  signal?: AbortSignal
): Promise<boolean> => {
  if (signal?.aborted) throw new Error('Sync aborted');

  try {
    const { registered } = await oxyServices.checkPublicKeyRegistered(publicKey);
    return registered;
  } catch {
    // If check fails, assume not registered and attempt registration
    return false;
  }
};

/**
 * Register public key with the server.
 */
const registerIdentity = async (
  oxyServices: OxyServices,
  publicKey: string,
  signal?: AbortSignal
): Promise<void> => {
  if (signal?.aborted) throw new Error('Sync aborted');

  try {
    const { signature, timestamp } = await SignatureService.createRegistrationSignature();
    await oxyServices.register(publicKey, signature, timestamp);
  } catch (error: unknown) {
    // Already registered is not an error
    if (!isAlreadyRegisteredError(error)) {
      throw error;
    }
  }
};

/**
 * Sync local identity with server.
 *
 * Flow:
 * 1. If already synced, attempt direct sign-in
 * 2. If sign-in fails (user not found, session expired), proceed to registration
 * 3. Check if public key is registered on server
 * 4. Register if needed
 * 5. Sign in
 */
export const syncIdentityWithServer = async (
  options: SyncServiceOptions
): Promise<SyncServiceResult> => {
  const { oxyServices, signIn, isAlreadySynced, signal, onSessionExpired } = options;

  // Get local public key. `getPublicKey()` returns `null` ONLY for a genuine
  // absence and now THROWS `IdentityUnavailableError` when storage is
  // locked/unreadable — we let that typed error propagate (the caller's sync
  // handler reports it) rather than mislabeling a locked keystore as
  // "No identity found on this device".
  const publicKey = await KeyManager.getPublicKey();
  if (!publicKey) {
    throw new Error('No identity found on this device');
  }
  if (signal?.aborted) {
    throw new Error('Sync aborted');
  }

  // Try direct sign-in if already synced
  const signedInUser = await attemptSignIn(isAlreadySynced, signIn, publicKey, onSessionExpired);
  if (signedInUser) {
    return { user: signedInUser, wasRegistered: false };
  }

  // Check registration and register if needed
  const isRegistered = await checkRegistration(oxyServices, publicKey, signal);
  if (!isRegistered) {
    await registerIdentity(oxyServices, publicKey, signal);
  }

  // Sign in after ensuring registration
  const user = await signIn(publicKey);
  return { user, wasRegistered: !isRegistered };
};
