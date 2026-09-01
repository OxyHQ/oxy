/**
 * Session-sync integration layer — intra-package use only.
 *
 * `@oxyhq/core` owns the platform-agnostic `SessionClient`, its host adapter,
 * and the pure `DeviceSessionState → services` projection helpers; those are
 * re-exported straight from core here so `OxyContext` has one import site.
 * `@oxyhq/services` supplies only the platform pieces: the thin
 * `createSessionClient` factory (injects socket.io-client `io` + the
 * device-first token transport), the `AuthStateStore` factory, and — for
 * `sessionMode: 'identity'` — the identity binding (platform pin store + the
 * memoised pinned account id).
 */
export { createSessionClient } from './createSessionClient';
export { createTokenTransport } from './tokenTransport';
export { createPlatformAuthStateStore } from './authStore';
export { useBackgroundSessionSync } from './useBackgroundSessionSync';
export { createIdentitySessionBinding, IdentityBoundSessionError } from './identityBinding';
export type { IdentitySessionBinding } from './identityBinding';
export {
  createSessionClientHost,
  accountIdsOf,
  activeSessionIdOf,
  activeUserOf,
  deviceStateToClientSessions,
} from '@oxyhq/core';
