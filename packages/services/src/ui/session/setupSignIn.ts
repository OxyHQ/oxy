/**
 * What a platform's setup client is told about each sign-in it commits.
 *
 * A platform that runs the SDK's own sign-in at its setup (OxyOS's login
 * screen) gives the provider its own store (`OxyProviderProps.authStateStore`),
 * and `save()` receives the credential the moment a sign-in commits. The
 * platform also needs to know HOW the person signed in, because its own setup
 * differs:
 *
 * - `'qr'`: approved from a device the person already holds (the QR a phone
 *   scans, or the Commons identity): passwordless, so the platform asks no
 *   password; its service redeems the approval for its own credential
 *   (`POST /session/device/platform`, ADR 0058 R6);
 * - `'password'`: the account's password, which the person just typed and the
 *   platform may reuse once (OxyOS keeps it as its offline verifier) instead of
 *   asking for it again; it is in `password`, with or without a second factor;
 * - `'emailCode'`: the code or the link sent by email;
 * - `'signup'`: a new account.
 *
 * Passed as `save()`'s second argument, and ONLY to a store the app provided:
 * the platform's default stores never receive it. The SDK never keeps the
 * password beyond handing it over, never persists it and never logs it.
 */

import type { AuthStateStore, PersistedAuthState } from '@oxy.so/core/session';

export type SetupSignInMethod = 'qr' | 'password' | 'emailCode' | 'signup';

export interface SetupSignInContext {
  method: SetupSignInMethod;
  /** The password just typed; present only when `method` is `'password'`. */
  password?: string;
}

/**
 * A platform's setup store: an {@link AuthStateStore} whose `save()` may also
 * read how the sign-in happened. Every `AuthStateStore` is one.
 */
export interface PlatformSetupAuthStateStore extends Omit<AuthStateStore, 'save'> {
  save(state: PersistedAuthState, context?: SetupSignInContext): Promise<boolean>;
}
