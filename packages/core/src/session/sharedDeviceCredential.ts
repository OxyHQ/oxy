/**
 * The shared native DeviceSession credential — one device, one session, many apps.
 *
 * ## What this is, and what it deliberately is NOT
 *
 * Two different secrets can make a native Oxy app boot signed in, and conflating
 * them is the bug this module exists to end:
 *
 *   Commons private identity key   → identity and signed approval ONLY. It is
 *                                    self-custody, irreplaceable, and must never
 *                                    become the general app session transport.
 *   Shared DeviceSession credential → THIS module. An ordinary `deviceId` +
 *                                    `deviceSecret` pair that restores ordinary
 *                                    official apps, follows the device's active
 *                                    context, and is individually rotatable and
 *                                    revocable server-side.
 *
 * An ordinary app needs the second one. Handing it the first — which is what the
 * `shared-key-signin` lane does today — gives every sibling app the ability to
 * sign as the user's cryptographic identity to obtain something as mundane as a
 * session. That lane stays as a recovery/compatibility path; this one supersedes
 * it for the ordinary case.
 *
 * ## Why sharing one credential is safe against the server
 *
 * `POST /session/device/token` does NOT rotate: the response echoes the presented
 * secret back as `nextDeviceSecret` precisely so several first-party apps sharing
 * one `DeviceSession` can refresh concurrently without invalidating one another.
 * So N apps holding one credential is a supported server state, not a race — and
 * because they then share ONE `DeviceSession`, they automatically share its
 * `activeContextId` and its token-free `session_state` broadcasts.
 *
 * ## The one safety rule everything here is built around
 *
 * A read that FAILED and a slot that is EMPTY must never be the same value. The
 * empty answer authorises writes (seed the slot); the failed answer must
 * authorise nothing. {@link SharedDeviceCredentialRead} keeps them apart at the
 * type level, and every decision below fails closed on anything that is not a
 * positive `absent`/`present`.
 *
 * Platform-agnostic: the actual keychain / keystore access is injected as a
 * {@link SharedDeviceCredentialStore} by `@oxyhq/services`. ESM-safe, no
 * `require()`, no react/react-native/expo imports.
 */

import { logger } from '../logger';
import type { AuthStateStore, PersistedAuthState } from './authStateStore';

/**
 * The zero-cookie device credential, as shared between apps. Exactly the pair
 * `POST /session/device/token` takes — nothing else travels through the shared
 * slot: no access token, no account id, no user id, no identity key.
 */
export interface SharedDeviceCredential {
  deviceId: string;
  deviceSecret: string;
}

/**
 * The outcome of reading the shared slot. FOUR states, and the distinction
 * between the last two is load-bearing:
 *
 * - `present`     — a well-formed credential was read.
 * - `absent`      — the read SUCCEEDED and the slot is empty. The only state that
 *                   may authorise seeding the slot.
 * - `unavailable` — the read failed (keychain locked, keystore unreadable, the
 *                   bridge returned something unrecognisable). Authorises
 *                   nothing: not adoption, and above all not a write.
 * - `unsupported` — this build has no shared slot at all (web, or a native app
 *                   without the module linked). Not an error; simply means the
 *                   app keeps its own per-app credential.
 */
export type SharedDeviceCredentialRead =
  | { state: 'present'; credential: SharedDeviceCredential }
  | { state: 'absent' }
  | { state: 'unavailable'; cause: unknown }
  | { state: 'unsupported' };

/**
 * The platform seam. `@oxyhq/services` implements this over the iOS Keychain
 * Access Group (a dedicated `keychainService`) or the Android signature-protected
 * `OxyDeviceSession` broker.
 */
export interface SharedDeviceCredentialStore {
  /** Never throws — a failure is reported as `unavailable`, never as `absent`. */
  read(): Promise<SharedDeviceCredentialRead>;
  /**
   * Publish the credential. Resolves `true` only when a read-back confirmed the
   * exact bytes landed; `false` on any failure. Never throws.
   */
  publish(credential: SharedDeviceCredential): Promise<boolean>;
  /** Drop this app's copy of the shared credential. Never throws. */
  clear(): Promise<void>;
}

/** Why {@link decideSharedDeviceJoin} declined to adopt the shared credential. */
export type SharedDeviceJoinSkipReason =
  | 'shared-unsupported'
  | 'shared-unreadable'
  | 'shared-empty'
  | 'local-credential-present';

/** What a booting app should do with the shared slot it just read. */
export type SharedDeviceJoinDecision =
  | { action: 'adopt'; credential: SharedDeviceCredential }
  | { action: 'skip'; reason: SharedDeviceJoinSkipReason };

/** Why {@link decideSharedDevicePublish} declined to write the shared slot. */
export type SharedDevicePublishSkipReason =
  | 'shared-unsupported'
  | 'shared-unreadable'
  | 'already-current'
  | 'owned-by-another-device';

/** What an app that just PROVED a credential should do with the shared slot. */
export type SharedDevicePublishDecision =
  | { action: 'publish' }
  | { action: 'skip'; reason: SharedDevicePublishSkipReason };

/** The usable `{deviceId, deviceSecret}` pair in a persisted state, or null. */
export function readLocalDeviceCredential(
  state: PersistedAuthState | null,
): SharedDeviceCredential | null {
  if (!state?.deviceId || !state.deviceSecret) {
    return null;
  }
  return { deviceId: state.deviceId, deviceSecret: state.deviceSecret };
}

/**
 * Narrow an UNTRUSTED bridge payload into a {@link SharedDeviceCredentialRead}.
 *
 * Anything unrecognised resolves to `unavailable`, never `absent`. A native
 * module returning a shape this build does not understand (an older app in the
 * signing group, a partially-applied upgrade) means we do not KNOW whether the
 * device has a shared session — and "do not know" must never authorise a write
 * that would overwrite one.
 */
export function normalizeSharedDeviceSessionRead(raw: unknown): SharedDeviceCredentialRead {
  if (!raw || typeof raw !== 'object') {
    return { state: 'unavailable', cause: new Error('shared device session bridge returned a non-object') };
  }
  const payload = raw as Record<string, unknown>;
  if (payload.status === 'absent') {
    return { state: 'absent' };
  }
  if (payload.status === 'present') {
    const deviceId = payload.deviceId;
    const deviceSecret = payload.deviceSecret;
    if (
      typeof deviceId === 'string' &&
      deviceId.length > 0 &&
      typeof deviceSecret === 'string' &&
      deviceSecret.length > 0
    ) {
      return { state: 'present', credential: { deviceId, deviceSecret } };
    }
    // A `present` verdict whose payload is incomplete is a broken slot, not an
    // empty one. Reporting `absent` here would let the next successful sign-in
    // overwrite whatever is really in there.
    return {
      state: 'unavailable',
      cause: new Error('shared device session bridge reported `present` with an incomplete credential'),
    };
  }
  if (payload.status === 'unavailable') {
    const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown';
    return { state: 'unavailable', cause: new Error(`shared device session slot unavailable: ${reason}`) };
  }
  return {
    state: 'unavailable',
    cause: new Error(`shared device session bridge returned an unrecognised status: ${String(payload.status)}`),
  };
}

/**
 * Should this app adopt the shared credential? Pure.
 *
 * Adoption happens in exactly ONE case: the shared slot holds a credential and
 * this app has none of its own. That single rule delivers the product
 * requirement — a newly installed official app joins the device's existing
 * session without another QR — while making the two failure modes that matter
 * unreachable:
 *
 *  - An app that is already signed in is NEVER moved onto another credential, so
 *    "no user is signed out merely because one app updates first" holds by
 *    construction, in both upgrade directions.
 *  - A failed read never looks like an empty slot, so a locked keychain resolves
 *    to "keep what I have" rather than "this is a fresh device".
 *
 * The cost is stated plainly: two apps that each already own a DIFFERENT device
 * session stay on their own until one of them loses its credential. Converging
 * them would mean signing one of them out or a server-side device merge, and
 * neither is something a boot path may do silently.
 */
export function decideSharedDeviceJoin(
  local: PersistedAuthState | null,
  shared: SharedDeviceCredentialRead,
): SharedDeviceJoinDecision {
  if (readLocalDeviceCredential(local) !== null) {
    return { action: 'skip', reason: 'local-credential-present' };
  }
  switch (shared.state) {
    case 'present':
      return { action: 'adopt', credential: shared.credential };
    case 'absent':
      return { action: 'skip', reason: 'shared-empty' };
    case 'unavailable':
      return { action: 'skip', reason: 'shared-unreadable' };
    case 'unsupported':
      return { action: 'skip', reason: 'shared-unsupported' };
  }
}

/**
 * Should this app write the credential it just proved into the shared slot? Pure.
 *
 * `proven` means the server accepted it moments ago — a successful sign-in or a
 * successful mint. Only a proven credential is ever published, so the slot can
 * never be seeded with something no app could use.
 *
 * A slot already held by a DIFFERENT `deviceId` is left alone. Overwriting it
 * would silently migrate every other app on this device onto our session at their
 * next cold boot — a real, user-visible change of who they are signed in as, and
 * not something a background persist may decide.
 */
export function decideSharedDevicePublish(
  proven: SharedDeviceCredential,
  shared: SharedDeviceCredentialRead,
): SharedDevicePublishDecision {
  switch (shared.state) {
    case 'unsupported':
      return { action: 'skip', reason: 'shared-unsupported' };
    case 'unavailable':
      return { action: 'skip', reason: 'shared-unreadable' };
    case 'absent':
      return { action: 'publish' };
    case 'present': {
      if (shared.credential.deviceId !== proven.deviceId) {
        return { action: 'skip', reason: 'owned-by-another-device' };
      }
      if (shared.credential.deviceSecret === proven.deviceSecret) {
        return { action: 'skip', reason: 'already-current' };
      }
      // Same device, newer secret. Sign-in rotates the secret (the mint does
      // not), so the just-proven one is the credential a fresh install should
      // join with.
      return { action: 'publish' };
    }
  }
}

/** The result of {@link publishProvenDeviceCredential}, for logs and tests. */
export type SharedDevicePublishOutcome =
  | { status: 'published' }
  | { status: 'publish-failed' }
  | { status: 'skipped'; reason: SharedDevicePublishSkipReason };

/**
 * Read the shared slot, apply {@link decideSharedDevicePublish}, and write when
 * it says so. Best-effort by contract: the caller's own durable credential is
 * already persisted, so a failure here only means a future install will have to
 * sign in interactively.
 */
export async function publishProvenDeviceCredential(deps: {
  shared: SharedDeviceCredentialStore;
  credential: SharedDeviceCredential;
}): Promise<SharedDevicePublishOutcome> {
  const read = await deps.shared.read();
  const decision = decideSharedDevicePublish(deps.credential, read);
  if (decision.action === 'skip') {
    if (decision.reason === 'shared-unreadable') {
      logger.debug(
        'shared device credential slot unreadable — not publishing (an unreadable slot is never an empty one)',
        { component: 'sharedDeviceCredential', method: 'publishProvenDeviceCredential' },
      );
    }
    return { status: 'skipped', reason: decision.reason };
  }
  const published = await deps.shared.publish(deps.credential);
  return published ? { status: 'published' } : { status: 'publish-failed' };
}

/**
 * Wrap a platform {@link AuthStateStore} so that every durable credential it
 * persists is ALSO mirrored into the shared slot.
 *
 * Writes mirror automatically; reads do NOT adopt. That split is deliberate:
 *
 *  - Mirroring on write is the right place because `save()` is where a proven
 *    credential lands, on every lane there is — interactive sign-in, the cold
 *    boot mint, the refresh scheduler, the 401 re-mint, shared-key recovery. One
 *    seam, no lane left out, and no new call site to forget.
 *  - Adopting on read would hide a change of WHO THIS APP IS SIGNED IN AS inside
 *    a storage primitive, and would run on every `load()`. Adoption is an
 *    explicit, once-per-boot cold-boot step instead (`shared-device-adopt`).
 *
 * `clear()` deliberately does NOT clear the shared slot. This app signing out is
 * not authority over the device-wide join point: other apps may still be signed
 * in on that same credential, and once the server session is really gone the
 * credential mints `no_active_session` for everyone anyway.
 */
export function createSharedMirroringAuthStateStore(deps: {
  local: AuthStateStore;
  shared: SharedDeviceCredentialStore;
}): AuthStateStore {
  const { local, shared } = deps;
  // Process-local memo of the credential we last observed the shared slot to
  // hold. Purely an optimization to keep the refresh scheduler from re-reading
  // the keychain every mint; a slot wiped out from under us is re-seeded on the
  // next launch rather than mid-process.
  let mirrored: SharedDeviceCredential | null = null;

  return {
    load: () => local.load(),
    clear: () => local.clear(),
    save: async (state) => {
      // The durable local write is the contract this store owes its caller —
      // run it first and report ITS result, unchanged. The mirror is additive.
      const durablePersisted = await local.save(state);
      const credential = readLocalDeviceCredential(state);
      if (!credential) {
        return durablePersisted;
      }
      if (
        mirrored !== null &&
        mirrored.deviceId === credential.deviceId &&
        mirrored.deviceSecret === credential.deviceSecret
      ) {
        return durablePersisted;
      }
      try {
        const outcome = await publishProvenDeviceCredential({ shared, credential });
        if (outcome.status === 'published' || (outcome.status === 'skipped' && outcome.reason === 'already-current')) {
          mirrored = credential;
        }
      } catch (error) {
        // A store implementation is contractually non-throwing, but a mirror
        // failure must never take down the durable write that already succeeded.
        logger.debug(
          'mirroring the device credential into the shared slot threw — the local credential is unaffected',
          { component: 'sharedDeviceCredential', method: 'save' },
          error,
        );
      }
      return durablePersisted;
    },
  };
}
