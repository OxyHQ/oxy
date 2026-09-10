/**
 * Pure passkey (WebAuthn) sign-in / registration orchestration.
 *
 * Extracted from `OxyContext` so the fixed `options → ceremony → verify → commit`
 * ordering is unit-testable with injected deps — the exact pattern
 * `commitSessionFlow.ts` (`commitDeviceSetAndResolve`) uses. The context methods
 * (`signInWithPasskey` / `registerWithPasskey` / `addPasskey`) are thin wrappers
 * that supply the real deps: the core `webauthn*` methods, the platform ceremony
 * client (`webauthn/passkeyClient`), and the internal `commitSession` funnel.
 *
 * All three GATE on `isSupported()` first (the platform client returns `false`
 * off the web) so an unsupported surface fails loudly before touching a ceremony.
 */

import type { LoginResult, LoginSessionResult } from '@oxy.so/contracts';
import type { CommitInput } from './oxyContextTypes';

/**
 * The result of `OxyServices.webauthnRegisterVerify` — either the LINK branch
 * (`{ success, message }`, bearer present, no session) or the SIGNUP branch (a
 * full {@link LoginResult}, which carries a `sessionId` on its session arm).
 */
export type PasskeyRegisterVerifyResult = { success: true; message: string } | LoginResult;

/** Thrown when a passkey flow is attempted on a surface that cannot run WebAuthn. */
export const PASSKEY_UNSUPPORTED_MESSAGE =
  'Passkeys are not available in this environment. Use another sign-in method.';

/** Project a session-arm login result onto the internal `commitSession` input. */
function toCommitInput(result: LoginSessionResult): CommitInput {
  return {
    sessionId: result.sessionId,
    accessToken: result.accessToken,
    deviceSecret: result.deviceSecret,
    deviceId: result.deviceId,
    expiresAt: result.expiresAt,
    userId: result.user.id,
    user: result.user,
  };
}

/** Injected dependencies for {@link runPasskeyLogin}. */
export interface RunPasskeyLoginDeps {
  isSupported: () => boolean;
  getLoginOptions: (username?: string) => Promise<unknown>;
  runCeremony: (optionsJSON: unknown) => Promise<unknown>;
  loginVerify: (
    response: unknown,
    envelope: { deviceName?: string; deviceFingerprint?: string; deviceId?: string },
  ) => Promise<LoginResult>;
  commit: (input: CommitInput) => Promise<void>;
  /**
   * When present, scopes login options to that user's registered passkeys
   * (username-first) — the path a NON-discoverable hardware key (e.g. a U2F
   * security key) needs, since it can't be found by a usernameless ceremony.
   * Omit for the discoverable / resident-credential path.
   */
  username?: string;
  deviceId?: string;
  deviceName?: string;
  deviceFingerprint?: string;
}

/**
 * Passkey SIGN-IN. With no `username` this is the usernameless
 * (discoverable-credential) flow; with a `username` it is username-first —
 * the server scopes `allowCredentials` to that user's passkeys so a
 * non-discoverable hardware key (U2F/security key) can be selected. Either way:
 * request login options, run the authentication ceremony, verify, then commit
 * the session. A passkey assertion is itself the strong factor — sign-in always
 * resolves to a completed session.
 */
export async function runPasskeyLogin(deps: RunPasskeyLoginDeps): Promise<void> {
  if (!deps.isSupported()) {
    throw new Error(PASSKEY_UNSUPPORTED_MESSAGE);
  }
  const options = await deps.getLoginOptions(deps.username);
  const response = await deps.runCeremony(options);
  const result = await deps.loginVerify(response, {
    deviceName: deps.deviceName,
    deviceFingerprint: deps.deviceFingerprint,
    deviceId: deps.deviceId,
  });
  await deps.commit(toCommitInput(result));
}

/** Injected dependencies for {@link runPasskeyRegister}. */
export interface RunPasskeyRegisterDeps {
  isSupported: () => boolean;
  getRegisterOptions: (username: string) => Promise<unknown>;
  runCeremony: (optionsJSON: unknown) => Promise<unknown>;
  registerVerify: (
    response: unknown,
    envelope: { username: string; deviceName?: string },
  ) => Promise<PasskeyRegisterVerifyResult>;
  commit: (input: CommitInput) => Promise<void>;
  username: string;
  deviceName?: string;
}

/**
 * Passkey SIGNUP: create a brand-new account whose first auth method is a
 * passkey. The verify signup branch mints a session (a {@link LoginSessionResult}
 * carrying `sessionId`), which is committed exactly like a password signup.
 */
export async function runPasskeyRegister(deps: RunPasskeyRegisterDeps): Promise<void> {
  if (!deps.isSupported()) {
    throw new Error(PASSKEY_UNSUPPORTED_MESSAGE);
  }
  const options = await deps.getRegisterOptions(deps.username);
  const response = await deps.runCeremony(options);
  const result = await deps.registerVerify(response, {
    username: deps.username,
    deviceName: deps.deviceName,
  });
  // Only the signup session arm carries `sessionId`; the link branch
  // (`{ success, message }`) does not.
  if (!('sessionId' in result)) {
    throw new Error('Passkey registration did not establish a session.');
  }
  await deps.commit(toCommitInput(result));
}

/** Injected dependencies for {@link runPasskeyAdd}. */
export interface RunPasskeyAddDeps {
  isSupported: () => boolean;
  getRegisterOptions: () => Promise<unknown>;
  runCeremony: (optionsJSON: unknown) => Promise<unknown>;
  registerVerify: (
    response: unknown,
    envelope: { deviceName?: string },
  ) => Promise<PasskeyRegisterVerifyResult>;
  onLinked: () => void;
  deviceName?: string;
}

/**
 * ADD a passkey to the already-signed-in account (bearer present). The verify
 * link branch returns `{ success, message }` with NO session — so this never
 * commits a session; it just fires `onLinked` (which invalidates the
 * auth-methods query). A session arm here would be a server contract violation.
 */
export async function runPasskeyAdd(deps: RunPasskeyAddDeps): Promise<void> {
  if (!deps.isSupported()) {
    throw new Error(PASSKEY_UNSUPPORTED_MESSAGE);
  }
  const options = await deps.getRegisterOptions();
  const response = await deps.runCeremony(options);
  const result = await deps.registerVerify(response, { deviceName: deps.deviceName });
  if ('sessionId' in result) {
    throw new Error('addPasskey unexpectedly minted a new session instead of linking.');
  }
  deps.onLinked();
}
