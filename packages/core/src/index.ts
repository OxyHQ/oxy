/**
 * @oxyhq/core — OxyHQ SDK Foundation
 *
 * Platform-agnostic core providing API client, authentication,
 * cryptographic identity, and shared utilities.
 *
 * Works in Node.js, Browser, and React Native.
 *
 * @example
 * ```ts
 * import { OxyServices, oxyClient } from '@oxyhq/core';
 *
 * const user = await oxyClient.getCurrentUser();
 * ```
 *
 * Every export below is NOMINAL — no `export *`, no barrels, no compat shims.
 * If a symbol does not appear here, it is NOT part of the public API.
 */

// Ensure crypto polyfills are loaded before anything else
import './crypto/polyfill';

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
export { OxyServices, AssetUrlResolutionError, OxyAuthenticationError, OxyAuthenticationTimeoutError, ServiceAssetMetadataError } from './OxyServices';
export { OXY_CLOUD_URL, oxyClient } from './OxyServices';
export type { LinkedHttpClient } from './OxyServices.base';
// Auth-refresh handler surface — consumed by `@oxyhq/services`'s OxyContext to
// install an in-session access-token refresh handler on the owner HttpService
// (the linked-client refresh path delegates back to it).
export type { AuthRefreshReason, AuthRefreshHandler } from './HttpService';

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
export {
  ServiceCredentialMismatchError,
} from './mixins/OxyServices.auth';
export {
  getCommonsApprovalBlockingReason,
  parseCommonsApprovalExpiresAt,
} from './utils/commonsApproval';
// Automatic "Sign in with Oxy" delivery selection — ONE pure decision that maps
// the caller's facts onto exactly one primary route (open Commons / await push / QR).
export { selectCommonsDelivery, pushTargetsFromDelivery, commonsDeliveryPlatform } from './utils/commonsDelivery';
export type {
    CommonsDeliveryFacts,
    CommonsDeliveryPlatform,
    CommonsDeliveryRoute,
} from './utils/commonsDelivery';
export type {
    ServiceTokenResponse,
    OAuthUserInfoResponse,
    OAuthTokenExchangeResult,
} from './mixins/OxyServices.auth';
// "Sign in with Oxy" — handoff (Workstream C)
export type {
    CommonsSignInHandle,
    CommonsSignInStatus,
    CommonsSignInPurpose,
    CommonsOAuthContext,
    CommonsApprovalInfo,
    CommonsApprovalSubjectAccount,
    CommonsSignInActionResult,
    CommonsOAuthFinalizeResult,
    CommonsDeliveryResult,
} from './mixins/OxyServices.auth';
// `denyCommonsSignIn`'s reason parameter is typed by `CommonsDenyReason`, which
// is a WIRE contract shared with the API (the request schema of
// `POST /auth/session/deny/:authorizeCode` and the persisted
// `AuthSession.deniedReason` enum read the same declaration). It lives in
// `@oxyhq/contracts` and is NOT re-exported here: consumers import API contract
// types directly from `@oxyhq/contracts`, per the package boundary rule.
// Push-token registration (Expo push tokens — never raw APNs/FCM device tokens).
export type {
    PushTokenPlatform,
    RegisterPushTokenInput,
} from './mixins/OxyServices.notifications';
export type { ServiceApp, ServiceActingAsVerification } from './mixins/OxyServices.utility';
export type {
    ContactDiscoveryMatch,
    ContactDiscoveryResponse,
} from './mixins/OxyServices.contacts';
export type {
    InitDeviceTransferResult,
    DeviceTransferOutcome,
} from './mixins/OxyServices.deviceTransfer';
export type {
    BulkFollowEntry,
    BulkFollowResult,
    BulkUnfollowEntry,
    BulkUnfollowResult,
    FollowMutationResult,
    ViewerGraph,
} from './mixins/OxyServices.user';
export { OxyAppDataIdentifierError } from './mixins/OxyServices.appData';

// ---------------------------------------------------------------------------
// User identity and handles
// ---------------------------------------------------------------------------
export {
    getNormalizedUserId,
    normalizeUserIdentity,
    normalizeUserIdentityOrNull,
} from './utils/userIdentity';
export {
    getCanonicalUserHandle,
    getNormalizedUserHandle,
} from './utils/userHandle';
export type { CanonicalUserHandleInput, UserHandleInput } from './utils/userHandle';
export { normalizeProfileLinks } from './utils/profileLinks';
export type { ProfileLink, ProfileLinkMetadata } from './utils/profileLinks';

// ---------------------------------------------------------------------------
// Connected apps (OAuth consent: public app identity + authorized-app grants)
// ---------------------------------------------------------------------------
export type {
    PublicApplication,
    ConnectedApp,
} from './mixins/OxyServices.connectedApps';

// ---------------------------------------------------------------------------
// App store (public storefront + reviews + the listing a publisher edits)
// ---------------------------------------------------------------------------
export type {
    StoreCategory,
    StoreRating,
    StoreListingSummary,
    StoreListingDetail,
    StoreScreenshot,
    StoreScreenshotPlatform,
    StoreReview,
    StoreOwnReview,
    WriteStoreReviewInput,
    StoreListingStatus,
    PublisherListing,
    WriteListingInput,
    AddScreenshotInput,
    UpdateScreenshotInput,
    StorePage,
    StorePageOptions,
    StoreReviewsOptions,
} from './mixins/OxyServices.store';

// ---------------------------------------------------------------------------
// Accounts (unified account graph: tree, membership, roles, bot credentials)
// plus the applications owned within it (Application = OAuth client).
// ---------------------------------------------------------------------------
export type {
    AccountKind,
    AccountCategoryId,
    AccountRelationship,
    AccountRole,
    AccountMemberStatus,
    AccountMemberSource,
    AccountMember,
    AccountNode,
    AccountCredentialType,
    AccountCredentialEnvironment,
    AccountCredentialStatus,
    AccountCredential,
    AccountCredentialWithSecret,
    RotateAccountCredentialResult,
    ListAccountsOptions,
    CreateAccountInput,
    UpdateAccountInput,
    ProvisionChannelInput,
    ProvisionChannelMemberInput,
    ProvisionChannelResult,
    InviteAccountMemberInput,
    UpdateAccountMemberInput,
    TransferAccountOwnershipInput,
    CreateAccountCredentialInput,
    AccountSuccessResult,
    SwitchAccountResult,
    // Applications owned within the account graph (Application = OAuth client).
    Application,
    ApplicationType,
    ApplicationStatus,
    ApplicationCredential,
    ApplicationCredentialType,
    ApplicationCredentialStatus,
    ApplicationEnvironment,
    CreateApplicationInput,
    UpdateApplicationInput,
    CreateApplicationCredentialInput,
    ApplicationCredentialWithSecret,
    RotateApplicationCredentialResult,
    ApplicationUsagePeriod,
    ApplicationUsageSummary,
    ApplicationUsageByDay,
    ApplicationUsageByEndpoint,
    ApplicationUsageStats,
} from './mixins/OxyServices.accounts';

export {
    ACCOUNT_CATEGORY_IDS,
    MAX_ACCOUNT_CATEGORIES,
    SELECTABLE_ACCOUNT_CATEGORY_IDS,
    isSelectableAccountCategoryId,
    kindAcceptsAccountCategories,
} from './mixins/OxyServices.accounts';

// ---------------------------------------------------------------------------
// Reputation (Oxy Trust: ledger, balances, disputes, rules, influence).
// The whole type family — the closed value sets, the two balance views and the
// `isFullReputationBalance` narrowing guard, the ledger/dispute/rule/leaderboard
// shapes, and the write-endpoint inputs — is owned by `@oxyhq/contracts`, which
// the API's serializers are validated against. Import them from there.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Self-sovereign identity (DID, signed records, auth-method ↔ VM mapping,
// verified domains). Wire shapes (DidDocument, SignedRecordEnvelope,
// AuthMethodsResponse, VerifiedDomain, DomainVerificationInstructions,
// ExportBundle) live in `@oxyhq/contracts` — import them directly from there.
// ---------------------------------------------------------------------------
export { buildUserDid } from './mixins/OxyServices.identity';
export type {
    IdentityRecordType,
    UnlinkableAuthMethodType,
    LinkAuthMethodResult,
    PublishRecordResult,
    VerifyRecordResult,
    VerifyDomainResult,
    RemoveDomainResult,
    RotateKeyProof,
    RotateKeyOptions,
    RotateKeyResult,
} from './mixins/OxyServices.identity';

// ---------------------------------------------------------------------------
// Civic / Commons "Oxy ID" (public signed cards + Oxy ID QR payload) and Fase 2
// anti-gaming (real-life attestation QR + validator/jury). Wire shapes
// (PublicCard, SignedPublicCard, RealLifeAttestationResult,
// ValidationRequestSummary, ValidationVoteResult, ValidationVerdict, …) live in
// `@oxyhq/contracts` — import them from there. The SDK adds the client verdict
// wrapper, the QR payload parsers/builders, and the submit inputs/results.
// ---------------------------------------------------------------------------
export {
    parseIdPayload,
    parseAttestPayload,
    verifyPublicCardAttestation,
} from './mixins/OxyServices.civic';
export type {
    CivicCardResult,
    IdCardRef,
    AttestQrPayload,
    ParsedAttestPayload,
    SubmitRealLifeAttestationInput,
    DenyValidationResult,
    VouchForPersonInput,
    WithdrawVouchResult,
    IssueCredentialInput,
    RevokeCredentialResult,
} from './mixins/OxyServices.civic';
export type { UserNodeStatus, UserNodeMode, UserNodeController, UserNodeLivenessStatus, RegisterNodeInput, RemoveNodeResult } from './mixins/OxyServices.nodes';

/**
 * Chains — the shared per-person record log. `ChainRecord` is generic over the
 * app's own lexicon payload, so a consumer types its records without Oxy
 * knowing any app's schema.
 */
export type { ChainRecord, ChainRecordPage, AppendedChainRecord } from './mixins/OxyServices.chains';

// ---------------------------------------------------------------------------
// Auth helpers (token refresh, error normalisation, retry policies)
// ---------------------------------------------------------------------------
export {
    SessionSyncRequiredError,
    AuthenticationFailedError,
    ensureValidToken,
    isAuthenticationError,
    withAuthErrorHandling,
    authenticatedApiCall,
} from './utils/authHelpers';
export type { HandleApiErrorOptions } from './utils/authHelpers';

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export {
    mergeSessions,
    normalizeAndSortSessions,
    sessionsArraysEqual,
} from './utils/sessionUtils';
export type {
    ClientSession,
    StorageKeys,
    MinimalUserData,
    SessionLoginResponse,
} from './models/session';

// ---------------------------------------------------------------------------
// Crypto / identity
// ---------------------------------------------------------------------------
export {
    KeyManager,
    IdentityAlreadyExistsError,
    IdentityPersistError,
    IdentityUnavailableError,
} from './crypto/keyManager';
export type { KeyPair, IdentityStatus, IdentityRecoveryResult } from './crypto/keyManager';
export {
    readIdentityMarker,
    updateIdentityMarker,
} from './crypto/identityMarker';
export type { IdentityMarker } from './crypto/identityMarker';
export { SignatureService } from './crypto/signatureService';
export type { SignedMessage, AuthChallenge } from './crypto/signatureService';
export { RecoveryPhraseService } from './crypto/recoveryPhrase';
export type { RecoveryPhraseResult, PendingIdentityResult, BackupMaterial } from './crypto/recoveryPhrase';

// Low-level crypto primitives (b3 Phase 0 — encrypted backup + device transfer)
export { hkdfSha256 } from './crypto/kdf';
export {
    encryptAead,
    decryptAead,
    AEAD_KEY_LENGTH,
    AEAD_NONCE_LENGTH,
} from './crypto/aead';
export type { AeadResult } from './crypto/aead';
export { deriveSharedSecret } from './crypto/ecdh';

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
export { DeviceManager } from './utils/deviceManager';
export type { DeviceFingerprint, StoredDeviceInfo } from './utils/deviceManager';

// ---------------------------------------------------------------------------
// Domain models / wire types
// ---------------------------------------------------------------------------
export type {
    OxyConfig,
    PrivacySettings,
    NotificationPreferences,
    UserPreferences,
    User,
    LoginResponse,
    Notification,
    Wallet,
    Transaction,
    BlockedUser,
    RestrictedUser,
    TransferFundsRequest,
    PurchaseRequest,
    WithdrawalRequest,
    TransactionResponse,
    PaginationInfo,
    SearchProfilesResponse,
    ApiError,
    PaymentMethod,
    PaymentRequest,
    PaymentResponse,
    AnalyticsData,
    FollowerDetails,
    ContentViewer,
    FileMetadata,
    FileUploadResponse,
    FileListResponse,
    FileUpdateRequest,
    FileDeleteResponse,
    RNFileDescriptor,
    AssetUploadInput,
    FileVisibility,
    AssetLink,
    AssetMetadata,
    AssetVariant,
    Asset,
    AssetInitRequest,
    AssetInitResponse,
    AssetCompleteRequest,
    AssetLinkRequest,
    AssetUnlinkRequest,
    AssetUrlResponse,
    BatchFileAccessEntry,
    BatchFileAccessResponse,
    AssetDeleteSummary,
    AssetUpdateVisibilityRequest,
    AssetUpdateVisibilityResponse,
    ServiceAssetMetadata,
    ServiceAssetMetadataBySha,
    AccountStorageCategoryUsage,
    AccountStorageUsageResponse,
    SecurityEventType,
    SecurityEventSeverity,
    SecurityActivity,
    SecurityActivityResponse,
    AssetUploadProgress,
    DeviceLinkedSession,
    DeviceLinkedSessionsResponse,
    DeviceLinkedSessionLogoutResponse,
    UpdateDeviceNameResponse,
} from './models/interfaces';
export { SECURITY_EVENT_SEVERITY_MAP } from './models/interfaces';

// Topic enums + type
export { TopicType, TopicSource } from './models/Topic';
export type { TopicData, TopicTranslation, TopicListResult } from './models/Topic';

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------
export {
    SUPPORTED_LANGUAGES,
    FALLBACK_LOCALE,
    getBaseLanguage,
    normalizeLocale,
    isSupportedLocale,
    getLanguageMetadata,
    getLanguageName,
    getNativeLanguageName,
    isRTLLocale,
    getUserLanguages,
    getPrimaryLanguage,
} from './utils/languageUtils';
export type { SupportedLanguage } from './utils/languageUtils';

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------
export {
    getPlatformOS,
    setPlatformOS,
    isWeb,
    isNative,
    isIOS,
    isAndroid,
    isWebBrowser,
} from './utils/platform';
export type { PlatformOS } from './utils/platform';

// ---------------------------------------------------------------------------
// Colour / theme utilities
// ---------------------------------------------------------------------------
export {
    darkenColor,
    lightenColor,
    hexToRgb,
    rgbToHex,
    withOpacity,
    isLightColor,
    getContrastTextColor,
} from './shared/utils/colorUtils';

export {
    normalizeTheme,
    normalizeColorScheme,
    getOppositeTheme,
    systemPrefersDarkMode,
    getSystemColorScheme,
} from './shared/utils/themeUtils';
export type { ThemeValue } from './shared/utils/themeUtils';

// ---------------------------------------------------------------------------
// HTTP / error / network helpers
// ---------------------------------------------------------------------------
export {
    HttpStatus,
    getErrorStatus,
    getErrorMessage,
    isAlreadyRegisteredError,
    isUnauthorizedError,
    isForbiddenError,
    isNotFoundError,
    isRateLimitError,
    isServerError,
    isNetworkError,
    isRetryableError,
} from './shared/utils/errorUtils';

export {
    DEFAULT_CIRCUIT_BREAKER_CONFIG,
    createCircuitBreakerState,
    calculateBackoffInterval,
    recordFailure,
    recordSuccess,
    shouldAllowRequest,
    delay,
    withRetry,
} from './shared/utils/networkUtils';
export type { CircuitBreakerState, CircuitBreakerConfig } from './shared/utils/networkUtils';

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
export { translate } from './i18n';
export { accountCategoryLabel } from './i18n/accountCategoryLabels';
export { accountRoleLabel } from './i18n/accountRoleLabels';
export { reputationCategoryLabel } from './i18n/reputationCategoryLabels';
export { trustTierLabel } from './i18n/trustTierLabels';

// ---------------------------------------------------------------------------
// API request / URL helpers
// ---------------------------------------------------------------------------
export {
    buildQueryParams,
    buildSearchParams,
    buildUrl,
    buildPaginationParams,
    safeJsonParse,
} from './utils/apiUtils';
export type {
    PaginationParams,
    FollowGraphParams,
    FollowGraphSort,
    ApiResponse,
    ErrorResponse,
} from './utils/apiUtils';

export {
    ErrorCodes,
    createApiError,
    handleHttpError,
    isHttpRequestError,
    parseHttpErrorBody,
    validateRequiredFields,
} from './utils/errorUtils';
export type { HttpRequestError, ParsedHttpErrorBody } from './utils/errorUtils';

export { retryAsync } from './utils/asyncUtils';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export {
    EMAIL_REGEX,
    USERNAME_REGEX,
    PASSWORD_REGEX,
    MAX_DISPLAY_NAME_LENGTH,
    DISPLAY_NAME_INVALID_MESSAGE,
    isValidEmail,
    isValidUsername,
    isValidPassword,
    isValidDisplayName,
    DISPLAY_NAME_ALLOWED_SCRIPTS,
    DISPLAY_NAME_DISALLOWED_SOURCE,
    DISPLAY_NAME_ORPHANED_MARK_SOURCE,
    DISPLAY_NAME_UNFLANKED_SEPARATOR_SOURCE,
    isRequiredString,
    isRequiredNumber,
    isRequiredBoolean,
    isValidArray,
    isValidObject,
    isValidUUID,
    isValidURL,
    isValidDate,
    isValidFileSize,
    isValidFileType,
    sanitizeString,
    sanitizeHTML,
    isValidObjectId,
    validateAndSanitizeUserInput,
} from './utils/validationUtils';

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------
export {
    normalizeInlineText,
    normalizeMultilineText,
} from './utils/textNormalization';

// ---------------------------------------------------------------------------
// Logging — the ecosystem-wide chokepoint (also at subpath `@oxyhq/core/logger`)
// ---------------------------------------------------------------------------
export {
    logger,
    createLogger,
    configureLogger,
    getLoggerConfig,
    resetLoggerConfig,
    consoleSink,
    isDev,
} from './logger';
export type {
    Logger,
    LogLevel,
    EmittableLogLevel,
    LogContext,
    LogEntry,
    LogSink,
    LoggerConfig,
} from './logger';

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------
export { updateAvatarVisibility } from './utils/avatarUtils';

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
export {
    buildAccountsArray,
    createQuickAccount,
    getAccountDisplayName,
    getAccountFallbackHandle,
    formatPublicKeyHandle,
    getAccountColor,
} from './utils/accountUtils';
export type { QuickAccount, DisplayNameUserShape } from './utils/accountUtils';

// ---------------------------------------------------------------------------
// Registrable-domain + central-IdP-apex helpers.
//
// `registrableApex` (eTLD+1) is consumed via the `@oxyhq/core/server`
// re-export by `packages/api/src/utils/sameSite.ts` for same-site origin
// checks; `CENTRAL_IDP_APEX` by `server/cors.ts`'s `createOxyCors` (auto-allows
// `*.oxy.so`).
// ---------------------------------------------------------------------------
export { registrableApex } from './utils/registrableApex';
export { CENTRAL_IDP_APEX } from './utils/authWebUrl';

// WebAuthn relying-party origin guard (client side). Mirrors the server's
// `isOxyApexOrigin` so consumers can decide whether to offer passkey UI on the
// current page (first-party Oxy origin / loopback only).
export { isOxyRpOrigin } from './utils/webauthnOrigin';

export { runColdBoot } from './utils/coldBoot';
export type {
    ColdBootStep,
    ColdBootStepResult,
    ColdBootSession,
    ColdBootSkip,
    ColdBootOutcome,
    RunColdBootOptions,
} from './utils/coldBoot';

// ---------------------------------------------------------------------------
// OAuth 2.0 Authorization Code + PKCE helpers ("Sign in with Oxy" third party).
// Standard OAuth against auth.oxy.so/authorize — no FedCM/cookies/SSO bounce.
// ---------------------------------------------------------------------------
export {
    buildOAuthAuthorizeUrl,
    computeCodeChallenge,
    generateOAuthState,
    generatePkcePair,
    DEFAULT_OAUTH_SCOPE,
    OXY_AUTHORIZE_URL,
    OXY_OAUTH_STATE_STORAGE_KEY,
    OXY_OAUTH_CODE_VERIFIER_STORAGE_KEY,
    OXY_OAUTH_REDIRECT_URI_STORAGE_KEY,
    OXY_OAUTH_RETURN_PATH_STORAGE_KEY,
    normalizeOAuthRedirectUri,
    canonicalizeOAuthRedirectUri,
    persistOAuthHandshake,
    readOAuthHandshake,
    clearOAuthHandshake,
    persistOAuthReturnPath,
    consumeOAuthReturnPath,
} from './utils/oauthPkce';
export type { PkcePair, BuildOAuthAuthorizeUrlParams } from './utils/oauthPkce';

export {
    isLoopbackOrigin,
    isOfficialWebOrigin,
    isAllowedDeviceJoinOrigin,
} from './utils/officialOrigins';

// ---------------------------------------------------------------------------
// Session sync (device-scoped multi-account session client)
// ---------------------------------------------------------------------------
export { SessionClient } from './session/SessionClient';
export type { TokenTransport, SessionClientHost, SessionClientOptions, DeviceCredential, SessionStateOrigin } from './session/SessionClient';
// The injectable socket factory type: consumers that bundle socket.io-client
// (services/auth-sdk) pass its `io` export as `socketFactory` so realtime sync
// never relies on core's lazy dynamic import of a bare specifier.
export type { SocketIOFactory, MinimalSocket } from './session/socketLoader';

// Shared SessionClient integration layer: the host adapter, the pure
// DeviceSessionState projection helpers, and the client factory are defined
// ONCE here so every `@oxyhq/services` platform variant reuses them instead of
// duplicating a local copy. Each consumer supplies its own `TokenTransport`
// (native vs. web mint strategies differ) to `createSessionClient`.
export { createSessionClientHost } from './session/sessionClientHost';
export { createSessionClient } from './session/createSessionClient';
export {
    deviceStateToClientSessions,
    activeSessionIdOf,
    activeUserOf,
    accountIdsOf,
} from './session/projectSessionState';

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
} from './session/deviceDirectory';
export type {
    DeviceContext,
    DeviceContextActor,
    DeviceContextSubject,
    DevicePrincipalGroup,
} from './session/deviceDirectory';

// The switcher's RENDER model over that projection — names, handles and avatar
// URLs resolved once. Shared by `@oxyhq/services`' account dialog and the
// auth.oxy.so chooser so the two cannot drift, the same reason the flat
// projection lived here before it.
export { buildSwitcherRows, showsPrincipalHeaders } from './session/deviceSwitcherRows';
export type {
    ResolveAvatarUrl,
    SwitcherContextRow,
    SwitcherPrincipalRow,
} from './session/deviceSwitcherRows';

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
} from './session/accountSwitchTargets';

// Headless controller for the unified account dialog. Framework-agnostic
// state machine + subscribe/getSnapshot store (bind via `useSyncExternalStore`)
// — sign-in is passkey (WebAuthn) or the Commons QR / shared-keychain handoff;
// password, social login, and 2FA were removed ecosystem-wide. Reuses
// `SessionClient.switchAccount` / `oxyServices.switchToAccount` for the uniform
// switch and the existing device-flow methods for sign-in.
export {
    AccountDialogController,
    createAccountDialogController,
} from './session/accountDialogController';
export type {
    AccountDialogControllerOptions,
    AccountDialogSnapshot,
    AccountDialogView,
    CommonsAvailability,
    PopupWindowHandle,
    SignInFlowPhase,
    SignInFlowState,
    SignInProgress,
} from './session/accountDialogController';

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
} from './session/authStateStore';
export type {
    PersistedAuthState,
    AuthStateStore,
    NativeKeyValueStorage,
} from './session/authStateStore';

// The shared NATIVE DeviceSession credential — how several official apps on one
// device end up on ONE `DeviceSession` and therefore one active context. It is an
// ordinary rotatable/revocable `deviceId` + `deviceSecret`, deliberately NOT the
// Commons private identity key: an app that only needs a session must never be
// handed the key that signs identity approvals.
export {
    createSharedMirroringAuthStateStore,
    decideSharedDeviceJoin,
    decideSharedDevicePublish,
    normalizeSharedDeviceSessionRead,
    publishProvenDeviceCredential,
    readLocalDeviceCredential,
} from './session/sharedDeviceCredential';
export type {
    SharedDeviceCredential,
    SharedDeviceCredentialRead,
    SharedDeviceCredentialStore,
    SharedDeviceJoinDecision,
    SharedDeviceJoinSkipReason,
    SharedDevicePublishDecision,
    SharedDevicePublishOutcome,
    SharedDevicePublishSkipReason,
} from './session/sharedDeviceCredential';

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
} from './session/identityPin';
export type { IdentityPin, IdentityPinStore } from './session/identityPin';
export {
    resolveIdentityPin,
    establishIdentitySession,
} from './session/identitySession';
export type {
    IdentityBinding,
    IdentityRequestOptions,
    EstablishedIdentitySession,
} from './session/identitySession';
// The typed `401 account_not_on_device` from a PINNED device-secret mint: the
// pinned account left this device's session set, so the caller re-establishes
// the identity session instead of dropping a healthy device credential.
export { AccountNotOnDeviceError } from './mixins/OxyServices.deviceBoot';

export {
    refreshPersistedSession,
    refreshDeviceSecretArm,
    createAuthRefreshHandler,
    installAuthRefreshHandler,
    startTokenRefreshScheduler,
    TOKEN_REFRESH_LEAD_MS,
} from './session/refresh';
export type { RefreshDeps, TokenRefreshSchedulerHandle, DeviceSecretMintOutcome } from './session/refresh';

export { runSessionColdBoot } from './boot/sessionColdBoot';
export type {
    RunSessionColdBootOptions,
    SessionMode,
    SignedOutReason,
    DeviceBootSession,
} from './boot/sessionColdBoot';

// API response contracts (request/response Zod schemas + inferred types) live in
// `@oxyhq/contracts` — the single source of truth shared by the backend and every
// client SDK. Import them directly from `@oxyhq/contracts`; `@oxyhq/core` does NOT
// re-export them (no barrel re-exports — clean imports from the owning package).

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export { packageInfo } from './constants/version';

// ---------------------------------------------------------------------------
// Default export (back-compat — OxyServices is the most common consumer entry)
// ---------------------------------------------------------------------------
import { OxyServices } from './OxyServices';
export default OxyServices;
