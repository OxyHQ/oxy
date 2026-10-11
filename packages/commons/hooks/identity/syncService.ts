import { isInvalidSessionError } from '@oxy.so/services';
import { KeyManager, SignatureService } from '@oxy.so/core/crypto';
import type { User, OxyServices } from '@oxy.so/core';
import { isAlreadyRegisteredError, UsernameRequiredError } from './identityErrors';

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
  /**
   * The username to register with when the key has no server account yet.
   * Registration carries it, so without one an unregistered key is never
   * registered: the sync throws {@link UsernameRequiredError} instead.
   */
  username?: string | null;
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
  onSessionExpired?: () => Promise<void>,
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
 * Check if public key is registered on the server: `true`/`false`, or the
 * error when the check itself failed.
 */
const checkRegistration = async (
  oxyServices: OxyServices,
  publicKey: string,
  signal?: AbortSignal,
): Promise<boolean | { error: unknown }> => {
  if (signal?.aborted) throw new Error('Sync aborted');

  try {
    const { registered } = await oxyServices.auth.isKeyRegistered(publicKey);
    return registered;
  } catch (error: unknown) {
    return { error };
  }
};

/**
 * Register public key with the server, with its username.
 */
const registerIdentity = async (
  oxyServices: OxyServices,
  publicKey: string,
  username: string,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted) throw new Error('Sync aborted');

  try {
    const { signature, timestamp } = await SignatureService.createRegistrationSignature();
    await oxyServices.auth.registerKey(publicKey, signature, timestamp, username);
  } catch (error: unknown) {
    // Already registered is not an error (a taken username is).
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
 * 4. Register if needed — WITH the username; no username → `UsernameRequiredError`
 *    (an account never exists without one, so the key waits for the username step)
 * 5. Sign in
 */
export const syncIdentityWithServer = async (
  options: SyncServiceOptions,
): Promise<SyncServiceResult> => {
  const { oxyServices, signIn, isAlreadySynced, signal, onSessionExpired, username } = options;

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

  // Check registration and register if needed. A failed check with a username
  // in hand still attempts registration (an already-registered key answers 409
  // and signs in); without one there is nothing to register with.
  const registration = await checkRegistration(oxyServices, publicKey, signal);
  const isRegistered = registration === true;
  if (!isRegistered) {
    if (!username) {
      if (typeof registration === 'object') throw registration.error;
      throw new UsernameRequiredError();
    }
    await registerIdentity(oxyServices, publicKey, username, signal);
  }

  // Sign in after ensuring registration
  const user = await signIn(publicKey);
  return { user, wasRegistered: !isRegistered };
};
