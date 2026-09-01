/**
 * The JS half of the native background session credential.
 *
 * A home-screen widget or a sync job refreshes while the app process is dead:
 * there is no JS runtime, so it cannot go through this SDK's normal session lane
 * at all. Native code needs its own way to obtain a bearer, and this module is
 * what gives it one — while the app runs, it provisions a purpose-built
 * credential and hands it to the native store that `so.oxy.session.OxyBackgroundSession`
 * reads.
 *
 * ## Why a separate credential rather than the device secret
 *
 * `POST /session/device/token` ROTATES the device secret on every mint, and the
 * presented secret dies 60 seconds later. Native code minting with it would be a
 * second writer to the value this SDK's whole session depends on — and since
 * `createNativeAuthStateStore` serves JS from an in-process mirror that never
 * re-reads storage, JS would be blind to that rotation. A worker killed between
 * the server's rotation and its local write would sign the user out of the app.
 * A credential that nobody rotates removes that failure mode instead of managing
 * it.
 *
 * ## What this does NOT do
 *
 * It never reads or writes `oxy.auth.v1` / expo-secure-store. The two credentials
 * live in different stores with one writer each, so there is nothing to keep in
 * lockstep and no state that can disagree.
 *
 * ## Android only, and web is refused rather than merely unsupported
 *
 * Web is gated off by an explicit platform check, not by the native module being
 * absent — provisioning in a browser origin would be a security downgrade, so it
 * must not depend on an incidental fact. See {@link loadNativeModule}. iOS has no
 * implementation yet and resolves to no module, so every function here degrades to
 * a no-op: an app can enable this and lose nothing on other platforms.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import type { OxyServices } from '@oxyhq/core';
import { logger } from '@oxyhq/core';

/**
 * The native module's surface. Deliberately write-mostly: there is no `get`,
 * because JS has no use for the secret it just wrote and keeping native as the
 * secret's only reader is one less place it can leak from.
 */
interface OxyBackgroundSessionNativeModule {
  /**
   * Store (replacing) the credential. Resolves `false` when it was rejected or
   * storage failed.
   *
   * Positional scalars rather than one object, matching the native signature — and
   * that shape is load-bearing, not a preference. Passing an object made this an
   * Expo Modules `Record`, and a `Record` does not convert in a consumer build of
   * this package: every call was rejected with `The 1st argument cannot be cast to
   * type CredentialInput (received class ReadableNativeMap)`, so the credential was
   * never stored and background refreshes stayed signed out. See the comment on
   * `AsyncFunction("put")` in `OxyBackgroundSessionModule.kt` for why, and do not
   * restore the object form without proving on a device that a `Record` converts.
   *
   * `expiresAtMs` is epoch millis, parsed from the server's ISO-8601 string here
   * rather than natively.
   */
  put(
    baseUrl: string,
    deviceId: string,
    secret: string,
    accountId: string,
    expiresAtMs: number,
  ): Promise<boolean>;
  /** Drop the credential and any cached access token. */
  clear(): Promise<boolean>;
  /** What is stored: the owning account and its expiry (epoch millis), or `null`. */
  peek(): Promise<{ accountId: string; expiresAt: number } | null>;
}

/**
 * Re-provision once the remaining lifetime drops below this.
 *
 * The server issues a 30-day credential; renewing with a week to spare means an
 * app opened even occasionally always holds a live one, while an app left unopened
 * for a month lets it lapse — which is the intended outcome, not a failure.
 */
const RENEW_WHEN_REMAINING_MS = 7 * 24 * 60 * 60 * 1000;

let nativeModule: OxyBackgroundSessionNativeModule | null | undefined;

/**
 * Resolve the native module once — and refuse outright on web.
 *
 * ## Web is excluded on purpose, and not merely because the module is absent
 *
 * The credential is deliberately NON-ROTATING and long-lived, which is safe only
 * because native background code is its sole consumer and nobody rotates it. A
 * browser origin already holds the ROTATING `deviceSecret`, and it has no
 * background worker to serve — so provisioning there would add a strictly weaker
 * long-lived secret alongside a stronger short-lived one. That is a downgrade, not
 * a harmless no-op, and the harm lands at the PROVISION CALL (which mints a live
 * server-side credential) regardless of whether anything manages to store it.
 *
 * That property must not rest on `requireOptionalNativeModule` happening to return
 * `null` on web. It does today — the module is registered for android only — but
 * that is an incidental fact a future web shim or a web-build native-module mock
 * would quietly reverse. So the platform is checked FIRST, before we even ask the
 * registry, and every entry point in this module inherits the gate.
 *
 * (A pre-deploy server makes this visible too: oxy-api's `sessionDevice` router
 * applies `requireSameSiteOrigin` path-agnostically, so an unmatched path answers
 * `404` to a native caller but `403 BAD_ORIGIN` to a browser one. Core's degrade is
 * deliberately narrow — `404 → null` only — because a real origin misconfiguration
 * on a CURRENT server also returns 403, and swallowing that would hide a genuine
 * bug. Platform gating belongs here, where the platform is actually known.)
 *
 * `requireOptionalNativeModule` (a static import Metro always resolves) rather
 * than a dynamic `import(moduleName)`: the latter compiles to `require(variable)`
 * in the CJS build, which Metro cannot resolve inside a consuming app — it
 * silently returned `null` there, which is exactly how the cross-app SSO bridge
 * broke once. Same reasoning as `loadSharedIdentityBridge` in `@oxyhq/protocol`.
 */
function loadNativeModule(): OxyBackgroundSessionNativeModule | null {
  if (nativeModule === undefined) {
    if (Platform.OS === 'web') {
      nativeModule = null;
      return nativeModule;
    }
    const native = requireOptionalNativeModule<Partial<OxyBackgroundSessionNativeModule>>(
      'OxyBackgroundSession',
    );
    nativeModule =
      native &&
      typeof native.put === 'function' &&
      typeof native.clear === 'function' &&
      typeof native.peek === 'function'
        ? {
            put: native.put.bind(native),
            clear: native.clear.bind(native),
            peek: native.peek.bind(native),
          }
        : null;
  }
  return nativeModule;
}

/** Whether this platform/app can hold a background credential at all. */
export function isBackgroundSessionSupported(): boolean {
  return loadNativeModule() !== null;
}

/**
 * Drop the stored credential. No-op where unsupported, and never throws.
 *
 * Called on sign-out and BEFORE an account switch's network work, so the window
 * in which background code could still serve the previous account is as short as
 * one local write.
 */
export async function clearBackgroundSession(): Promise<void> {
  const native = loadNativeModule();
  if (!native) {
    return;
  }
  try {
    await native.clear();
  } catch (error) {
    logger.warn('[backgroundSession] could not clear the native background credential', {
      component: 'backgroundSession',
      error,
    });
  }
}

export interface BackgroundSessionSyncInput {
  oxyServices: OxyServices;
  /** The signed-in account, or `null` when signed out. */
  userId: string | null;
  /** Whether a bearer is available yet — provisioning requires one. */
  canUsePrivateApi: boolean;
  /**
   * Whether this run is still the current one. A run that loses its relevance
   * mid-flight (unmount, or another identity change) must not write the
   * credential it was about to write.
   */
  isCurrent: () => boolean;
}

/**
 * Fail LOUDLY when the installed `@oxyhq/core` predates
 * `provisionBackgroundCredential`.
 *
 * This is the one failure here that is a build/dependency mistake rather than a
 * runtime condition, and it is the one that must never be quiet. Everything else
 * in `syncBackgroundSession` is caught and logged at warn, which is right for a
 * flaky network — but applying that to a version skew would leave background
 * refreshes permanently non-functional behind a warning nobody reads. So this
 * throws, and logs at ERROR first so it is still visible in a release build whose
 * rejection handler is silent.
 *
 * Reachable only through a runtime skew: the declared `@oxyhq/core` range covers
 * the method, so a correctly-resolved install cannot get here, and TypeScript
 * rules it out at compile time.
 */
function assertProvisioningAvailable(oxyServices: OxyServices): void {
  if (typeof oxyServices.provisionBackgroundCredential === 'function') {
    return;
  }
  const message =
    '[backgroundSession] the installed @oxyhq/core has no provisionBackgroundCredential, ' +
    'so no background credential can be provisioned and native background refreshes will ' +
    'never authenticate. Install a @oxyhq/core that satisfies this package\'s declared range.';
  logger.error(message, undefined, { component: 'backgroundSession' });
  throw new Error(message);
}

/**
 * Bring the native credential in line with the session JS currently holds.
 *
 * Ordering is the load-bearing part: a credential belonging to a DIFFERENT
 * account is cleared before any network call, so a crash mid-provision leaves
 * background code signed out rather than serving the previous account's data
 * under the new account's name. The server enforces the same rule independently
 * (a mint is re-authorized against the live device session, and against its ACTIVE
 * account), so this is the fast local half of a belt-and-braces pair, not the only
 * guard.
 *
 * Throws for exactly one thing — a `@oxyhq/core` too old to provision (see
 * {@link assertProvisioningAvailable}). Every other failure is caught and logged:
 * a background credential is an enhancement, and failing to provision one must
 * not disturb the session that is working.
 */
export async function syncBackgroundSession(input: BackgroundSessionSyncInput): Promise<void> {
  const native = loadNativeModule();
  if (!native) {
    return;
  }
  const { oxyServices, userId, canUsePrivateApi, isCurrent } = input;

  // Before the try, so the catch below cannot turn a dependency skew into a
  // warning. Signed-out is exempt: clearing needs no core method, and a sign-out
  // must never be blocked by one.
  if (userId) {
    assertProvisioningAvailable(oxyServices);
  }

  try {
    if (!userId) {
      // Signed out. Local-only, so it works with no bearer and no network.
      await native.clear();
      return;
    }

    const stored = await native.peek();
    if (stored && stored.accountId !== userId) {
      // Identity changed under a live credential — clear FIRST, provision after.
      await native.clear();
    }

    const isForCurrentAccount = stored?.accountId === userId;
    const hasLifeLeft =
      isForCurrentAccount && stored.expiresAt - Date.now() > RENEW_WHEN_REMAINING_MS;
    if (hasLifeLeft) {
      return;
    }

    // Everything below needs a bearer. Without one yet (cold boot still
    // resolving) there is nothing to do but wait for the next run — the token
    // landing re-triggers this.
    if (!canUsePrivateApi || !isCurrent()) {
      return;
    }

    const provisioned = await oxyServices.provisionBackgroundCredential();
    if (!provisioned) {
      // `null` means the endpoint is not deployed yet. Expected during the
      // rollout window (api leads the SDK) and deliberately quiet.
      return;
    }
    if (!isCurrent()) {
      return;
    }
    if (provisioned.accountId !== userId) {
      // The active account moved while the request was in flight, so this
      // credential is already for the wrong account. Drop it; the next run
      // provisions for the account that is actually signed in.
      await native.clear();
      return;
    }

    const expiresAt = Date.parse(provisioned.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      logger.warn('[backgroundSession] server returned an unparseable credential expiry', {
        component: 'backgroundSession',
      });
      return;
    }

    const persisted = await native.put(
      oxyServices.getBaseURL(),
      provisioned.deviceId,
      provisioned.secret,
      provisioned.accountId,
      expiresAt,
    );
    if (!persisted) {
      logger.warn(
        '[backgroundSession] the native store did not retain the background credential; background refreshes stay signed out until the next attempt',
        { component: 'backgroundSession' },
      );
    }
  } catch (error) {
    logger.warn('[backgroundSession] could not sync the native background credential', {
      component: 'backgroundSession',
      error,
    });
  }
}
