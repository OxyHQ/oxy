/**
 * Identity-bound session — pin reconciliation + establishment.
 *
 * This is the SDK half of "an identity vault's authenticated user is whoever
 * owns the local primary key". Two operations, both consumed by the cold boot
 * (`boot/sessionColdBoot.ts`) and the re-mint lane (`session/refresh.ts`):
 *
 *  - {@link resolveIdentityPin} — read the persisted `{publicKey, accountId}`
 *    pin and reconcile it against the identity currently on this device. A
 *    definitive mismatch (the key was replaced, or is gone) CLEARS the pin; an
 *    INDETERMINATE read (keychain locked / storage threw) leaves it untouched.
 *  - {@link establishIdentitySession} — mint a session from the PRIMARY local
 *    key (`getPublicKey` → `requestChallenge` → `signChallenge` →
 *    `verifyChallenge`), persist the resulting device credential, and write the
 *    pin. This is the identity-mode replacement for the shared-keychain lane,
 *    which reads the CROSS-APP shared slot and may therefore hold a different
 *    identity than this device's primary.
 *
 * Both take their key/signature functions from an injectable {@link IdentityBinding}
 * (defaulting to `KeyManager` / `SignatureService`) so the lanes above stay
 * testable without a keychain.
 *
 * ESM-safe (no `require()`); no react/react-native/expo imports.
 */

import type { OxyServices } from '../OxyServices';
import type { AuthStateStore } from './authStateStore';
import type { SessionLoginResponse } from '../models/session';
import { KeyManager } from '../crypto/keyManager';
import { SignatureService, type AuthChallenge } from '../crypto/signatureService';
import { identityPinMatches, type IdentityPin, type IdentityPinStore } from './identityPin';
import { logger } from '../logger';

/** Per-call transport overrides forwarded to the challenge/verify round-trips. */
export interface IdentityRequestOptions {
  retry?: boolean;
  timeout?: number;
}

/**
 * Everything an identity-bound client needs to resolve and re-establish its
 * session. `@oxy.so/services` builds one of these (platform-appropriate pin
 * store) and passes it to the cold boot and the refresh handler.
 */
export interface IdentityBinding {
  /** Where the `{publicKey, accountId}` pin is persisted. */
  pinStore: IdentityPinStore;
  /**
   * Reads this device's PRIMARY identity public key. Defaults to
   * `KeyManager.getPublicKey()`. NEVER the shared-slot key.
   */
  readPublicKey?: () => Promise<string | null>;
  /**
   * Signs a server challenge with the PRIMARY local private key. Defaults to
   * `SignatureService.signChallenge`.
   */
  signChallenge?: (challenge: string) => Promise<AuthChallenge>;
  /** Optional device labels forwarded to `verifyChallenge`. */
  deviceName?: string;
  deviceFingerprint?: string;
}

/** The result of a successful {@link establishIdentitySession}. */
export interface EstablishedIdentitySession {
  session: SessionLoginResponse;
  /** The pin as written: the local key plus the account the server resolved for it. */
  pin: IdentityPin;
}

function readPublicKeyOf(binding: IdentityBinding): () => Promise<string | null> {
  return binding.readPublicKey ?? (() => KeyManager.getPublicKey());
}

function signChallengeOf(binding: IdentityBinding): (challenge: string) => Promise<AuthChallenge> {
  return binding.signChallenge ?? ((challenge) => SignatureService.signChallenge(challenge));
}

/**
 * Read the persisted pin and reconcile it against the identity on this device.
 *
 * Returns the pin ONLY when the local primary public key still matches it — that
 * is the single condition under which a client may bind its token and its
 * rendered user to that account.
 *
 * Outcomes:
 *  - no pin stored → `null` (nothing to clear).
 *  - local key MATCHES → the pin (trusted).
 *  - local key read succeeded and differs / is absent → the identity was
 *    replaced or lost: CLEAR the pin and return `null`. Keeping it would pin the
 *    client to an account it can no longer prove control of.
 *  - the local key read THREW (keychain locked, storage unavailable) → return
 *    `null` WITHOUT clearing. A read that produced no verdict is never evidence
 *    of an identity change (the same rule `KeyManager` applies to its own
 *    transient errors); the caller falls through to the identity sign-in lane,
 *    which fails closed on a locked keychain rather than adopting a foreign
 *    account.
 */
export async function resolveIdentityPin(binding: IdentityBinding): Promise<IdentityPin | null> {
  const pin = await binding.pinStore.load();
  if (!pin) {
    return null;
  }

  let localPublicKey: string | null;
  try {
    localPublicKey = await readPublicKeyOf(binding)();
  } catch (error) {
    logger.debug(
      'Identity key read did not produce a verdict — keeping the pin untouched',
      { component: 'identitySession', method: 'resolveIdentityPin' },
      error,
    );
    return null;
  }

  if (identityPinMatches(pin, localPublicKey)) {
    return pin;
  }

  logger.warn(
    'Identity pin no longer matches the device identity key — clearing it (the identity was replaced or removed)',
    { component: 'identitySession', method: 'resolveIdentityPin' },
  );
  await binding.pinStore.clear();
  return null;
}

/**
 * Establish a session for the device's PRIMARY identity key and pin it.
 *
 * `requestChallenge` → `signChallenge` → `verifyChallenge`; `verifyChallenge`
 * plants the access token itself. The server resolves the account from the
 * VERIFIED SIGNER, so the returned session is identity-authoritative — it
 * ignores the device's `activeAccountId` entirely.
 *
 * Side effects on success: the durable device credential is persisted (so the
 * next boot can take the fast pinned-mint lane) and the pin is written.
 *
 * Returns `null` — never throws — for the two "nothing to do" cases: no local
 * identity (including every web caller, where `KeyManager` has no key), and a
 * verify that produced no access token. Network/crypto failures propagate so the
 * caller can classify them.
 */
export async function establishIdentitySession(args: {
  oxy: OxyServices;
  store: AuthStateStore;
  binding: IdentityBinding;
  requestOptions?: IdentityRequestOptions;
}): Promise<EstablishedIdentitySession | null> {
  const { oxy, store, binding, requestOptions } = args;

  const publicKey = await readPublicKeyOf(binding)();
  if (!publicKey) {
    return null;
  }

  const { challenge } = await oxy.requestChallenge(publicKey, requestOptions);
  const signed = await signChallengeOf(binding)(challenge);
  if (signed.publicKey.toLowerCase() !== publicKey.toLowerCase()) {
    // The signer disagrees with the key we resolved a challenge for — the
    // identity changed mid-flight, or a custom signer was misconfigured. Refuse:
    // verifying under a different key would bind this client to another account.
    throw new Error('Identity sign-in aborted: the signing key does not match the device identity key');
  }

  // `signed.challenge` carries the SIGNATURE (mirrors `signChallengeWithSharedKey`).
  const session = await oxy.verifyChallenge(
    signed.publicKey,
    challenge,
    signed.challenge,
    signed.timestamp,
    binding.deviceName,
    binding.deviceFingerprint,
    requestOptions,
  );
  if (!session?.accessToken) {
    return null;
  }

  // Persist the rotating device credential so later boots re-mint through the
  // fast `POST /session/device/token` lane instead of re-signing a challenge.
  if (session.deviceId && session.deviceSecret) {
    await store.save({
      sessionId: session.sessionId,
      userId: session.user.id,
      deviceId: session.deviceId,
      deviceSecret: session.deviceSecret,
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
    });
  }

  const pin: IdentityPin = { publicKey: publicKey.toLowerCase(), accountId: session.user.id };
  // A failed pin persist is NOT fatal: this process is already pinned in memory,
  // and a later boot without a pin skips the (unpinned) mint lane and re-runs
  // this exact lane, which rewrites it. Never fail an established session on it.
  const pinned = await binding.pinStore.save(pin);
  if (!pinned) {
    logger.warn(
      'Identity session established but the pin did not durably persist — the next cold start will re-establish it',
      { component: 'identitySession', method: 'establishIdentitySession' },
    );
  }

  return { session, pin };
}
