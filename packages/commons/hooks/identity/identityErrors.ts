/**
 * Utility functions for error handling in identity operations
 */

import { IdentityAlreadyExistsError, IdentityUnavailableError } from '@oxy.so/core/crypto';

/**
 * Thrown by the create/import preflight when the identity KEYS are absent but an
 * independent {@link readIdentityMarker} record says an identity DID exist on
 * this device (a `lost` verdict, or a marker seen concurrently after an `absent`
 * read). Overwriting in that state would destroy a recoverable identity, so the
 * preflight refuses and callers route into the recovery UX instead.
 *
 * Defined LOCALLY in commons (not exported from core) because it is purely a
 * routing/UX signal for the app's onboarding gate — the authoritative
 * blast-radius protection is the atomic overwrite guard inside `KeyManager`.
 */
export class IdentityMayExistError extends Error {
  readonly name = 'IdentityMayExistError';
  /** The public key recorded by the marker — lets recovery validate the account. */
  readonly markerPublicKey: string;
  constructor(markerPublicKey: string) {
    super('An identity may already exist on this device and must be recovered, not overwritten.');
    this.markerPublicKey = markerPublicKey;
  }
}

/**
 * True for the two typed preflight refusals that mean "do NOT create/overwrite —
 * an identity is (or may be) here": {@link IdentityMayExistError} (marker-backed
 * lost/concurrent) and {@link IdentityUnavailableError} (storage unreadable).
 * Callers map these to the recovery/retry UX rather than the generic
 * "Failed to create identity" error. {@link IdentityAlreadyExistsError} is
 * handled separately (it carries the resume/sign-in path).
 */
export const isIdentityRecoveryRefusal = (
  error: unknown,
): error is IdentityMayExistError | IdentityUnavailableError =>
  error instanceof IdentityMayExistError || error instanceof IdentityUnavailableError;

/**
 * True for any of the three typed refusals a create preflight can raise
 * (already-exists, may-exist, or storage-unavailable) — i.e. an outcome that
 * must NOT be surfaced as a hard "creation failed" error.
 */
export const isIdentityPreflightRefusal = (
  error: unknown,
): error is IdentityAlreadyExistsError | IdentityMayExistError | IdentityUnavailableError =>
  error instanceof IdentityAlreadyExistsError || isIdentityRecoveryRefusal(error);

/**
 * Type guard for errors that expose a numeric `status` field
 * (e.g. fetch-style errors, ApiError instances from @oxy.so/core).
 */
function hasNumericStatus(e: unknown): e is { status: number } {
  return (
    typeof e === 'object' &&
    e !== null &&
    'status' in e &&
    typeof (e as { status: unknown }).status === 'number'
  );
}

/** The 409 `POST /auth/register` answers when the chosen username is taken. */
const USERNAME_TAKEN_MESSAGE = /username already taken/i;

/**
 * Check if a registration failed because the chosen username is taken (409
 * `Username already taken`). The username is part of registration, so this is
 * a 409 that must NOT be read as "this key is already registered".
 */
export const isUsernameTakenError = (error: unknown): boolean => {
  if (!hasNumericStatus(error) || error.status !== 409) return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && USERNAME_TAKEN_MESSAGE.test(message);
};

/**
 * Check if an error indicates this key is already registered — a 409 that is
 * not {@link isUsernameTakenError}. Already-registered is not a failure: the
 * caller signs in.
 */
export const isAlreadyRegisteredError = (error: unknown): boolean => {
  if (!error) return false;
  return hasNumericStatus(error) && error.status === 409 && !isUsernameTakenError(error);
};

/**
 * Thrown by the identity sync when the key has no server account and no
 * username has been chosen yet. Registration carries the username, so the
 * account cannot be created until the username step has run; callers route
 * there (or, from the background reconnect loop, wait). Matched by
 * `isUsernameRequiredError` through its `code`.
 */
export class UsernameRequiredError extends Error {
  readonly name = 'UsernameRequiredError';
  readonly code = 'USERNAME_REQUIRED';
  constructor() {
    super('A username is required before this identity can be registered.');
  }
}
