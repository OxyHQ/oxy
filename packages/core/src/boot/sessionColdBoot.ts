/**
 * Device-first session cold boot for every consumer.
 *
 * On a fresh page load / app launch this resolves the device's session in a
 * deterministic order, built on the pure `runColdBoot` primitive. It NEVER
 * redirects to a login page: an unresolved boot ends in a signed-out state that
 * the app renders with a "Sign in with Oxy" button.
 *
 * Ordered steps (first to yield a session wins):
 *   1. `warm-token-plant` (web + native) — the fastest path: when the persisted
 *      store still holds a warm access token that is valid for more than the
 *      refresh lead window, plant it and yield the session with NO network
 *      round-trip. The background scheduler rotates it shortly after.
 *   2. `device-secret-mint` (web + native) — the zero-cookie transport: when the
 *      origin persisted a `deviceId` + `deviceSecret`, mint a short access token
 *      with a single bearer-less POST to `/session/device/token` (no cookie, no
 *      navigation) and rotate the secret in-use.
 *   3. `shared-device-adopt` (native, ACCOUNT mode) — this app has no credential
 *      of its own but a sibling official app already put one in the shared native
 *      slot: adopt it and mint. This is how a newly installed official app joins
 *      the device's existing session WITHOUT another QR and without ever touching
 *      the Commons private key.
 *   4. `shared-key-signin` (native, ACCOUNT mode) — the legacy lane: re-mint by
 *      signing with the shared-keychain IDENTITY key. Retained as a recovery /
 *      compatibility path for devices whose apps have not yet published a shared
 *      device credential — OR `identity-key-signin` (IDENTITY mode) — re-mint
 *      from THIS device's primary identity key.
 *   5. Signed out.
 *
 * Two session modes (see {@link RunSessionColdBootOptions.sessionMode}):
 *   - `account` (default) — the device's ACTIVE account owns the session. Every
 *     Oxy app but the identity vault boots this way; behaviour is unchanged.
 *   - `identity` — the owner of the local PRIMARY identity key owns the session,
 *     permanently, regardless of which account the device is switched to. Each
 *     step above is bound to the persisted identity pin, and the shared-keychain
 *     lane is replaced by the primary-key one (the shared slot is a CROSS-APP
 *     slot that may hold a different identity).
 *
 * ESM-safe (no `require()`); no react/react-native/expo imports.
 */
import { runColdBoot, type ColdBootOutcome, type ColdBootStep } from '../utils/coldBoot';
import { isNative as detectNative } from '../utils/platform';
import { logger } from '../logger';
import { computeIdentityTag } from '../utils/cacheKey';
import { TOKEN_REFRESH_LEAD_MS, refreshDeviceSecretArm } from '../session/refresh';
import {
  establishIdentitySession,
  resolveIdentityPin,
  type IdentityBinding,
} from '../session/identitySession';
import type { IdentityPin } from '../session/identityPin';
import {
  decideSharedDeviceJoin,
  type SharedDeviceCredentialStore,
} from '../session/sharedDeviceCredential';
import type { OxyServices } from '../OxyServices';
import type { AuthStateStore, PersistedAuthState } from '../session/authStateStore';

/**
 * Who owns the session this boot resolves.
 *
 * - `account` — the device's active account (every ordinary Oxy app).
 * - `identity` — the owner of the device's primary identity key (the identity
 *   vault). Requires {@link RunSessionColdBootOptions.identity}.
 */
export type SessionMode = 'account' | 'identity';

/** The winning session shape a cold-boot step reports. */
export interface DeviceBootSession {
  sessionId: string;
  userId: string;
  accessToken: string;
}

/** Why a cold boot ended without a session. */
export type SignedOutReason = 'no_session' | 'error';

export interface RunSessionColdBootOptions {
  oxy: OxyServices;
  store: AuthStateStore;
  /** Platform hints; default derived from `@oxyhq/core`'s platform detection. */
  platform?: { isWeb?: boolean; isNative?: boolean };
  /** Invoked with the winning session (token already planted). */
  onSession?: (session: DeviceBootSession & { via: string }) => void | Promise<void>;
  /** Invoked when the boot ended signed out. */
  onSignedOut?: (reason: SignedOutReason) => void | Promise<void>;
  onStepError?: (id: string, error: unknown) => void;
  /**
   * HARD overall deadline (ms) for the whole ordered step chain, forwarded to
   * {@link runColdBoot}. Defense-in-depth so a single non-settling network step
   * (a black-hole network that neither connects nor rejects) can NEVER hang the
   * boot — and therefore app routing — indefinitely. Inert on healthy loads
   * (every step settles well under it); only trips on pathological networks.
   * When omitted there is no overall deadline (unchanged behavior).
   */
  overallDeadlineMs?: number;
  /**
   * Invoked once per step abandoned because {@link overallDeadlineMs} expired
   * before it settled. Forwarded to {@link runColdBoot}. Must not throw.
   */
  onStepDeadline?: (stepId: string) => void;
  /**
   * Best-effort connectivity hint. When it returns `true` the two NETWORK steps
   * (`device-secret-mint`, `shared-key-signin`) are skipped — an offline device
   * cannot mint, and attempting to would burn the whole deadline on a doomed
   * request before routing settles. The pure-local `warm-token-plant` step is
   * NEVER gated by this: an offline returning user with an unexpired persisted
   * token must still boot authenticated. Only an EXPLICIT offline verdict should
   * be returned; the caller resolves unknown/timeout to `false` (assume online)
   * so a flaky probe can never falsely skip a real sign-in.
   */
  isOffline?: () => boolean;
  /**
   * Who owns the resolved session. Defaults to `'account'` — the device's active
   * account — which is the behaviour every ordinary Oxy app has today and which
   * this option leaves byte-for-byte unchanged.
   *
   * `'identity'` binds the boot to the owner of this device's PRIMARY identity
   * key and REQUIRES {@link identity}. When it is missing the boot refuses to
   * run any lane (an identity-bound client silently falling back to the device's
   * active account is precisely the bug this mode exists to prevent) and
   * resolves signed out.
   */
  sessionMode?: SessionMode;
  /**
   * The identity binding (pin store + key/signature access) used by
   * `sessionMode: 'identity'`. Ignored in `'account'` mode.
   */
  identity?: IdentityBinding;
  /**
   * The cross-app native slot holding this device's shared DeviceSession
   * credential, enabling the `shared-device-adopt` lane. Supplied by
   * `@oxyhq/services` on native; absent on web, where each origin is its own
   * device by design.
   *
   * IGNORED in `sessionMode: 'identity'`. The shared slot belongs to whichever
   * principal signed in on this device; an identity-bound client must resolve
   * its session from the local key alone, and adopting a device credential is
   * exactly the drift that mode exists to prevent.
   */
  sharedDeviceCredential?: SharedDeviceCredentialStore;
}

/**
 * Run the device-first cold boot. Resolves to the `runColdBoot` outcome and, as
 * a side effect, invokes `onSession` (winning session, token already planted) or
 * `onSignedOut` (no session).
 */
export async function runSessionColdBoot(
  opts: RunSessionColdBootOptions,
): Promise<ColdBootOutcome<DeviceBootSession>> {
  const { oxy, store } = opts;
  const isNative = opts.platform?.isNative ?? detectNative();

  // Non-null ONLY in identity mode; every `!== null` test below therefore reads
  // as "is this boot identity-bound?" while also narrowing the binding.
  const identityBinding = opts.sessionMode === 'identity' ? opts.identity ?? null : null;
  if (opts.sessionMode === 'identity' && identityBinding === null) {
    logger.error(
      'runSessionColdBoot: sessionMode "identity" requires an `identity` binding — refusing to run any lane (an identity-bound client must never adopt the device active account)',
      undefined,
      { component: 'sessionColdBoot', method: 'runSessionColdBoot' },
    );
    await opts.onSignedOut?.('error');
    return { kind: 'unauthenticated' };
  }

  // Best-effort connectivity gate for the NETWORK steps only. A missing hint or
  // any non-`true` verdict means "assume online" — never falsely skip a real
  // sign-in on an ambiguous probe.
  const isOffline = (): boolean => opts.isOffline?.() ?? false;

  // Boot-local (not module-level) so it cannot leak across boots or break under
  // bundler re-evaluation.
  let signedOutReason: SignedOutReason = 'no_session';

  // Boot-local memo for the identity pin. Resolved lazily INSIDE a step so the
  // (local, but storage-backed) read is covered by `overallDeadlineMs`, and
  // resolved at most once per boot so two steps cannot disagree. Always `null`
  // in account mode.
  let pinResolved = false;
  let cachedPin: IdentityPin | null = null;
  const getIdentityPin = async (): Promise<IdentityPin | null> => {
    if (identityBinding === null) {
      return null;
    }
    if (!pinResolved) {
      cachedPin = await resolveIdentityPin(identityBinding);
      pinResolved = true;
    }
    return cachedPin;
  };

  const steps: Array<ColdBootStep<DeviceBootSession>> = [];

  // 1. warm-token-plant (web + native) — the fastest path. When the persisted
  //    store already holds a still-valid warm access token (its expiry more than
  //    the refresh lead window away) plus its owning session identity, plant it
  //    and yield the session IMMEDIATELY, skipping the blocking mint round-trip on
  //    first paint. The token is used AS-IS: this step NEVER mints, rotates, or
  //    persists anything. The proactive `startTokenRefreshScheduler` + the
  //    request-time preflight (both wired in the services provider) rotate it in
  //    the background; a revoked token self-heals via the 401 -> re-mint -> clear
  //    path. This exposure is sanctioned by `authStateStore.ts` (~L30-36): the
  //    warm token is short-lived and adds nothing over the already-persisted
  //    `deviceSecret`.
  steps.push({
    id: 'warm-token-plant',
    run: async () => {
      const persisted = await store.load();
      if (!persisted?.accessToken || !persisted.sessionId || !persisted.userId || !persisted.expiresAt) {
        return { kind: 'skip' };
      }
      // Guard a malformed `expiresAt` (Date.parse -> NaN): treat as not-valid and
      // fall through to the mint lane. A token still inside the refresh lead
      // window (or already expired) is likewise skipped — let the mint lane get a
      // fresh one rather than plant a token about to expire.
      const expiresAtMs = new Date(persisted.expiresAt).getTime();
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() + TOKEN_REFRESH_LEAD_MS) {
        return { kind: 'skip' };
      }
      if (identityBinding !== null) {
        // Identity-bound: a persisted token is only acceptable when it belongs to
        // the PINNED account. Both the token's own claim (`computeIdentityTag`,
        // the same derivation `SessionClient.applyState` uses) and the owning
        // session identity must match — a token planted for another account by an
        // earlier account-mode write is exactly the durable drift this gate stops.
        const pin = await getIdentityPin();
        if (
          pin === null ||
          persisted.userId !== pin.accountId ||
          computeIdentityTag(persisted.accessToken) !== pin.accountId
        ) {
          return { kind: 'skip' };
        }
      }
      oxy.setTokens(persisted.accessToken);
      return {
        kind: 'session',
        session: {
          sessionId: persisted.sessionId,
          userId: persisted.userId,
          accessToken: persisted.accessToken,
        },
      };
    },
  });

  // 2. device-secret-mint (web + native) — the zero-cookie fast path. When the
  //    origin persisted a deviceId + deviceSecret, mint a short access token with
  //    a single bearer-less POST (no cookie, no navigation). The mint itself runs
  //    through `refreshDeviceSecretArm`, which acquires the client's PROCESS-WIDE
  //    single-flight, persists `nextDeviceSecret` BEFORE planting the token, and
  //    returns a classified outcome — so concurrent mint lanes share one in-flight
  //    request and the durable store always converges on the server's credential.
  steps.push({
    id: 'device-secret-mint',
    // Network step — skip entirely when the caller reports the device offline so
    // a doomed mint cannot burn the overall deadline before routing settles.
    enabled: () => !isOffline(),
    run: async () => {
      const pin = await getIdentityPin();
      if (identityBinding !== null && pin === null) {
        // Identity-bound with no verified pin (never written, or cleared because
        // the local key changed/vanished). An UNPINNED mint would adopt whichever
        // account the device is currently switched to — the exact drift this mode
        // exists to prevent. Fall through to `identity-key-signin`, which
        // re-derives the account from the local key and rewrites the pin.
        return { kind: 'skip' };
      }
      const result = await refreshDeviceSecretArm({ oxy, store, pin });
      switch (result.status) {
        case 'ok':
          // The arm persisted nextDeviceSecret and planted the token.
          return {
            kind: 'session',
            session: {
              sessionId: result.sessionId,
              userId: result.userId,
              accessToken: result.token,
            },
          };
        case 'invalid-secret': {
          // Stale/diverged secret — drop it so the mint lane stops firing. On
          // native the shared-key step below can still recover; on web this ends
          // signed out. Setting it undefined drops the key on the store's JSON
          // serialization, and the mint guard treats undefined as absent.
          const persisted = await store.load();
          if (persisted) {
            await store.save({ ...persisted, deviceSecret: undefined });
          }
          return { kind: 'skip' };
        }
        case 'no-session':
          // Device known, no live session — authoritative signed-out. Keep the
          // secret (the device may sign in again).
          signedOutReason = 'no_session';
          return { kind: 'skip' };
        case 'persist-failed':
          // The mint rotated the secret but it could not be durably persisted —
          // refuse to advertise a session that will not survive a reload. Keep
          // the secret; a later boot/attempt re-mints once storage recovers.
          logger.error(
            'device-secret mint rotated the secret but it could not be durably persisted — not planting',
            undefined,
            { component: 'sessionColdBoot', method: 'device-secret-mint' },
          );
          return { kind: 'skip' };
        case 'account-not-on-device':
          // Pinned mint rejected: the pinned account is no longer a live account
          // of this device session. The secret is healthy — keep it untouched and
          // let `identity-key-signin` re-establish from the local key.
          logger.debug(
            'pinned device-secret mint rejected (account_not_on_device) — keeping secret, re-establishing from the identity key',
            { component: 'sessionColdBoot', method: 'device-secret-mint' },
          );
          return { kind: 'skip' };
        case 'transient':
          // Network / 5xx: keep the secret; a later attempt can succeed.
          logger.debug(
            'device-secret mint failed (transient) — keeping secret',
            { component: 'sessionColdBoot', method: 'device-secret-mint' },
          );
          return { kind: 'skip' };
        case 'no-secret':
          return { kind: 'skip' };
      }
    },
  });

  if (identityBinding !== null) {
    // 3-identity. identity-key-signin — re-mint from THIS device's PRIMARY
    //    identity key (`getPublicKey` → challenge → sign → verify). It REPLACES
    //    `shared-key-signin`, which reads the CROSS-APP shared keychain slot and
    //    may therefore hold a different identity than the device's primary — the
    //    one thing an identity-bound client must never adopt. The server resolves
    //    the account from the verified signer, so the winning session is
    //    identity-authoritative and the pin is (re)written from it.
    //
    //    Online-gated like every network step; `{ retry: false }` keeps the two
    //    round-trips single attempts (the refresh scheduler / 401 lane own later
    //    retries) so this step cannot multiply boot latency. On web
    //    `KeyManager.getPublicKey()` resolves to `null`, so it skips.
    steps.push({
      id: 'identity-key-signin',
      enabled: () => !isOffline(),
      run: async () => {
        const established = await establishIdentitySession({
          oxy,
          store,
          binding: identityBinding,
          requestOptions: { retry: false },
        });
        const accessToken = established?.session.accessToken;
        if (!established || !accessToken) {
          return { kind: 'skip' };
        }
        return {
          kind: 'session',
          session: {
            sessionId: established.session.sessionId,
            userId: established.session.user.id,
            accessToken,
          },
        };
      },
    });
  } else if (opts.sharedDeviceCredential) {
    // 3. shared-device-adopt (native, ACCOUNT mode) — join the device's existing
    //    session through the shared native credential slot.
    //
    //    This is the lane that separates identity from session transport. What it
    //    reads is an ordinary, individually revocable `deviceId` + `deviceSecret`
    //    put there by a sibling official app — never the Commons private key. It
    //    is what lets a freshly installed official app land signed in with no QR,
    //    and it is why an ordinary app never needs identity-key access at all.
    //
    //    `decideSharedDeviceJoin` gates it: an app that already holds its own
    //    credential is never moved, and an UNREADABLE slot is never mistaken for
    //    an empty one. The lane therefore cannot sign anyone out, in either
    //    upgrade order.
    const sharedSlot = opts.sharedDeviceCredential;
    steps.push({
      id: 'shared-device-adopt',
      // The adoption itself is local, but it is only worth committing alongside
      // a mint that proves the credential — so the whole lane is online-gated
      // like every other network step.
      enabled: () => isNative && !isOffline(),
      run: async () => {
        const before = await store.load();
        const decision = decideSharedDeviceJoin(before, await sharedSlot.read());
        if (decision.action === 'skip') {
          logger.debug(
            `shared device credential not adopted (${decision.reason})`,
            { component: 'sessionColdBoot', method: 'shared-device-adopt' },
          );
          return { kind: 'skip' };
        }

        // Restore the store to exactly what it held before this lane touched it.
        // A credential we adopted and could not prove must not be left behind for
        // the next boot's mint lane to keep retrying.
        const revert = async (): Promise<void> => {
          if (before) {
            await store.save(before);
          } else {
            await store.clear();
          }
        };

        const adopted: PersistedAuthState = {
          // The mint fills both in from the device's live state; carrying the
          // previous session's ids into a different device session would be a
          // lie for however long the mint takes.
          sessionId: '',
          userId: '',
          deviceId: decision.credential.deviceId,
          deviceSecret: decision.credential.deviceSecret,
        };
        if (!(await store.save(adopted))) {
          logger.error(
            'adopted the shared device credential but it could not be durably persisted — reverting',
            undefined,
            { component: 'sessionColdBoot', method: 'shared-device-adopt' },
          );
          await revert();
          return { kind: 'skip' };
        }

        const result = await refreshDeviceSecretArm({ oxy, store, pin: null });
        if (result.status === 'ok') {
          return {
            kind: 'session',
            session: {
              sessionId: result.sessionId,
              userId: result.userId,
              accessToken: result.token,
            },
          };
        }

        if (result.status === 'invalid-secret') {
          // The one place we hold POSITIVE proof that the exact bytes in the
          // shared slot are dead — the server rejected them by name. Clearing it
          // signs nobody out (a credential the server does not recognise cannot
          // be minting for anyone) and it is what stops a dead credential from
          // blocking every future install: a stale slot owned by a different
          // `deviceId` is otherwise never overwritten, by design.
          await sharedSlot.clear();
        } else if (result.status === 'no-session') {
          signedOutReason = 'no_session';
        }
        await revert();
        return { kind: 'skip' };
      },
    });
  }

  if (identityBinding === null) {
    // 4. shared-key-signin (native) — the RECOVERY / COMPATIBILITY lane: sign a
    //    challenge with the shared-keychain IDENTITY key to re-mint a session.
    //
    //    It runs LAST on purpose. Using the self-custody key to obtain an ordinary
    //    session is the over-sharing #937 sets out to end, so it is now reachable
    //    only on a device where no sibling app has published a shared device
    //    credential yet — an install that predates this lane, or one where the
    //    shared slot is unreadable. Its own `store.save` below feeds the shared
    //    slot through the mirroring store, so the FIRST boot that takes this lane
    //    is also the last one that needs to: every later app joins by credential.
    //
    //    Native AND online: it is a network step (challenge + verify round-trips),
    //    so it is gated by the same offline hint as the mint lane. `{ retry: false }`
    //    keeps the two round-trips as single attempts — the refresh scheduler /
    //    401 lane own later retries — so this step cannot multiply boot latency.
    steps.push({
      id: 'shared-key-signin',
      enabled: () => isNative && !isOffline(),
      run: async () => {
        const session = await oxy.signInWithSharedIdentity({ requestOptions: { retry: false } });
        if (!session?.accessToken) {
          return { kind: 'skip' };
        }
        // `verifyChallenge` mints a rotating deviceSecret; persist it so the next
        // boot can use the faster device-secret-mint lane (sockets + tab-focus
        // re-mint depend on the credential being in the store).
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
        return {
          kind: 'session',
          session: {
            sessionId: session.sessionId,
            userId: session.user.id,
            accessToken: session.accessToken,
          },
        };
      },
    });
  }

  const outcome = await runColdBoot<DeviceBootSession>({
    steps,
    overallDeadlineMs: opts.overallDeadlineMs,
    onStepDeadline: opts.onStepDeadline,
    onStepError: (id, error) => {
      signedOutReason = 'error';
      opts.onStepError?.(id, error);
    },
  });

  if (outcome.kind === 'session') {
    await opts.onSession?.({ ...outcome.session, via: outcome.via });
    return outcome;
  }

  await opts.onSignedOut?.(signedOutReason);
  return outcome;
}
