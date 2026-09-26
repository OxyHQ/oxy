/**
 * `@oxy.so/core/session` — the device-first session machinery.
 *
 * The multi-account `SessionClient`, the headless account dialog, the persisted
 * auth-state stores, the token re-mint handler and scheduler, and the cold
 * boot. `@oxy.so/services` builds `OxyProvider` on it; an app that only calls
 * the API with a token it already has never needs it.
 */

// Session code reaches the identity key (identity-bound sessions), so the
// crypto shim goes first — see `../crypto/polyfill`.
import '../crypto/polyfill';

export { DeviceManager } from '../utils/deviceManager';
export type { DeviceFingerprint, StoredDeviceInfo } from '../utils/deviceManager';

// ---------------------------------------------------------------------------
// Session sync (device-scoped multi-account session client)
// ---------------------------------------------------------------------------
export { SessionClient } from './SessionClient';
export type { TokenTransport, SessionClientHost, SessionClientOptions, DeviceCredential, SessionStateOrigin } from './SessionClient';
// Injectable for tests/specialized hosts; ordinary consumers use core's lazy
// transport and do not pull socket.io-client into their initial module graph.
export type { SocketIOFactory, MinimalSocket } from './socketLoader';

// Shared SessionClient integration layer: the host adapter, the pure
// DeviceSessionState projection helpers, and the client factory are defined
// ONCE here so every `@oxy.so/services` platform variant reuses them instead of
// duplicating a local copy. Each consumer supplies its own `TokenTransport`
// (native vs. web mint strategies differ) to `createSessionClient`.
export { createSessionClientHost } from './sessionClientHost';
export { createSessionClient } from './createSessionClient';
export {
    deviceStateToClientSessions,
    activeSessionIdOf,
    activeUserOf,
    accountIdsOf,
} from './projectSessionState';

// Pure projections over the device DIRECTORY (`GET /session/device/directory`,
// ADR 0002) — the read model that keeps the actor (the human who authenticated)
// and the subject (the account being acted as) apart. The flat
// `DeviceSessionState` collapses them into one row, so it can neither tell
// "signed in as an org" from "a person operating that org" nor hold two people
// reaching the same org on one device.
// `canActivateContext` is the switchability question — `available` alone, never
// composed with `onDevice`, which is a different fact in both directions.
// `projectDevicePrincipals` is the switcher's shape: people, each with what
// they may become. Grouped rather than flat because the same organization
// reached through two people is TWO rows under two humans, which a list keyed
// by account cannot say.
export {
    canActivateContext,
    directoryDisplayName,
    directoryHandle,
    projectDevicePrincipals,
    resolveActiveContext,
    resolveDeviceContext,
} from './deviceDirectory';
export type {
    DeviceContext,
    DeviceContextActor,
    DeviceContextSubject,
    DevicePrincipalGroup,
} from './deviceDirectory';

// The switcher's RENDER model over that projection — names, handles and avatar
// URLs resolved once. Shared by `@oxy.so/services`' account dialog and the
// auth.oxy.so chooser so the two cannot drift, the same reason the flat
// projection lived here before it.
export { buildSwitcherRows, showsPrincipalHeaders } from './deviceSwitcherRows';
export type {
    ResolveAvatarUrl,
    SwitcherContextRow,
    SwitcherPrincipalRow,
} from './deviceSwitcherRows';

// The switch-target predicates over the account GRAPH — a list of accounts to
// manage, not the device's list of identities to become (that is the directory
// above). `isSwitchTargetAccount` is the structural half ("is this kind
// switchable at all?"); `canSwitchIntoAccount` adds the caller's
// `account:act_as` permission. Exported so the surfaces that render
// `AccountNode`s — the Console workspace switcher, managed-accounts rows — ask
// the SAME questions instead of testing a kind literal.
export {
    isSwitchTargetAccount,
    canSwitchIntoAccount,
} from './accountSwitchTargets';

// The service/agent counterpart to the human switch predicates above. Kept on
// its own semantic seam because `bot` is delegable but never human-switchable.
export { resolveAccountDelegationAccess } from './accountDelegationAccess';
export type {
    AccountDelegationAccess,
    AccountDelegationNode,
} from './accountDelegationAccess';

// Headless controller for the unified account dialog. Framework-agnostic
// state machine + subscribe/getSnapshot store (bind via `useSyncExternalStore`)
// — sign-in runs through `oxy.auth` (email, password, authenticator, the
// Commons QR / shared-keychain handoff). Reuses `SessionClient.switchAccount` /
// `oxy.accounts.actAs` for the uniform switch.
export {
    AccountDialogController,
    createAccountDialogController,
} from './accountDialogController';
export type {
    AccountDialogControllerOptions,
    AccountDialogSnapshot,
    AccountDialogView,
    CommonsAvailability,
    ContextChoiceOutcome,
    SignInFailureReason,
    SignInFlowPhase,
    SignInFlowState,
    SignInProgress,
} from './accountDialogController';

// ---------------------------------------------------------------------------
// Device-first session machinery (zero-cookie transport).
// Persisted auth-state store, the unified re-mint handler + scheduler, and the
// cold-boot runner. Built ON the `runColdBoot` primitive + `SessionClient`. The
// device credential is `deviceId` + `deviceSecret`; the access token is re-minted
// via `POST /session/device/token`.
// ---------------------------------------------------------------------------
export {
    createWebAuthStateStore,
    createNativeAuthStateStore,
    createMemoryAuthStateStore,
    AUTH_STATE_STORAGE_KEY,
} from './authStateStore';
export type {
    PersistedAuthState,
    AuthStateStore,
    NativeKeyValueStorage,
} from './authStateStore';

// The shared NATIVE DeviceSession credential — how several official apps on one
// device end up on ONE `DeviceSession` and therefore one active context. It is an
// ordinary revocable `deviceId` + `deviceSecret`, deliberately NOT the
// Commons private identity key: an app that only needs a session must never be
// handed the key that signs identity approvals.
export {
    createSharedMirroringAuthStateStore,
    decideSharedDeviceJoin,
    decideSharedDevicePublish,
    normalizeSharedDeviceSessionRead,
    publishProvenDeviceCredential,
    readLocalDeviceCredential,
} from './sharedDeviceCredential';
export type {
    SharedDeviceCredential,
    SharedDeviceCredentialRead,
    SharedDeviceCredentialStore,
    SharedDeviceJoinDecision,
    SharedDeviceJoinSkipReason,
    SharedDevicePublishDecision,
    SharedDevicePublishOutcome,
    SharedDevicePublishSkipReason,
} from './sharedDeviceCredential';

// Identity-bound sessions (the identity vault). The pin is the durable
// `{publicKey, accountId}` binding between this device's PRIMARY identity key
// and the account it authenticates as; it is what keeps such a client from
// following the device's mutable `activeAccountId`.
export {
    createWebIdentityPinStore,
    createNativeIdentityPinStore,
    createMemoryIdentityPinStore,
    identityPinMatches,
    IDENTITY_PIN_STORAGE_KEY,
} from './identityPin';
export type { IdentityPin, IdentityPinStore } from './identityPin';
export {
    resolveIdentityPin,
    establishIdentitySession,
} from './identitySession';
export type {
    IdentityBinding,
    IdentityRequestOptions,
    EstablishedIdentitySession,
} from './identitySession';
export {
    refreshPersistedSession,
    refreshDeviceSecretArm,
    createAuthRefreshHandler,
    installAuthRefreshHandler,
    startTokenRefreshScheduler,
    TOKEN_REFRESH_LEAD_MS,
} from './refresh';
export type { RefreshDeps, TokenRefreshSchedulerHandle, DeviceSecretMintOutcome } from './refresh';

export { runSessionColdBoot } from '../boot/sessionColdBoot';
export type {
    RunSessionColdBootOptions,
    SessionMode,
    SignedOutReason,
    DeviceBootSession,
} from '../boot/sessionColdBoot';

export { runColdBoot } from '../utils/coldBoot';
export type {
    ColdBootStep,
    ColdBootStepResult,
    ColdBootSession,
    ColdBootSkip,
    ColdBootOutcome,
    RunColdBootOptions,
} from '../utils/coldBoot';

