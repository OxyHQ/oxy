/**
 * @oxy.so/core — the Oxy SDK foundation.
 *
 * ```ts
 * import { OxyServices } from '@oxy.so/core';
 *
 * const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
 * const me = await oxy.users.me();
 * ```
 *
 * The root entry is the API client and what it needs; heavier pieces have their
 * own entries so an app ships only what it uses:
 * - `@oxy.so/core/session`   — device-first sessions, the account dialog, cold boot
 * - `@oxy.so/core/crypto`    — the self-custody identity (keys, recovery phrase)
 * - `@oxy.so/core/civic`     — Oxy ID QR payloads
 * - `@oxy.so/core/inference` — the inference client
 * - `@oxy.so/core/server`    — `OxyServer`: service tokens and middleware
 *
 * Every export below is NOMINAL — no `export *`, no barrels, no compat shims.
 * If a symbol does not appear here, it is NOT part of the public API.
 */

// The crypto shim MUST stay the first import. The root itself ships no crypto
// library (`__tests__/rootEntryGraph.test.ts`), but `@oxy.so/protocol`'s root
// entry (reached by the OAuth/PKCE and device helpers) does, and Metro does not
// tree-shake: on Hermes, `@noble/hashes` would capture an absent
// `globalThis.crypto` at evaluation. See the note in `./crypto/polyfill`.
import './crypto/polyfill';

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
export { OxyServices, OXY_API_URL, OXY_CLOUD_URL } from './OxyServices';
export type { OxyConfig, LinkedHttpClient } from './OxyServices';
export {
  OxyApiError,
  OxyAuthenticationError,
  OxyAuthenticationTimeoutError,
  AssetUrlResolutionError,
  ServiceAssetMetadataError,
} from './OxyServices.errors';
export type { HttpMethod } from './client/context';
export type { RequestOptions, AuthenticatedResponseRequest, AuthRefreshReason, AuthRefreshHandler } from './HttpService';

// The namespaces — their classes (for typing) and their input/output types.
export type { SessionApi, DeviceCredentialProvider, SessionValidation } from './api/session';
export type {
    AuthApi,
    ChallengeResponse,
    RegistrationRequest,
    ChallengeVerifyRequest,
    PublicKeyCheckResponse,
    OAuthUserInfoResponse,
    OAuthTokenExchangeResult,
    CommonsSignInHandle,
    CommonsSignInStatus,
    CommonsSignInPurpose,
    CommonsOAuthContext,
    CommonsApprovalInfo,
    CommonsApprovalSubjectAccount,
    CommonsSignInActionResult,
    CommonsOAuthFinalizeResult,
    CommonsDeliveryResult,
    SignInDeviceOptions,
    ClaimedSession,
} from './api/auth';
export type { UsersApi, ResolveExternalUserInput, DeleteAccountProof } from './api/users';
export type {
    FollowsApi,
    FollowMutationResult,
    BulkFollowEntry,
    BulkFollowResult,
    BulkUnfollowEntry,
    BulkUnfollowResult,
    ViewerGraph,
    EnsureFollowTargetInput,
    RegisterFollowKindInput,
} from './api/follows';
export type { PrivacyApi } from './api/privacy';
export type { NotificationsApi, PushTokenPlatform, RegisterPushTokenInput } from './api/notifications';
export { assetUrlCacheTTL } from './api/assets';
export type {
    AssetsApi,
    AssetRecord,
    UploadedAsset,
    AssetLinkState,
    AssetUploadOptions,
    AssetLinkTarget,
    AssetDeleteResult,
} from './api/assets';
export { buildUserDid } from './api/identity';
export type {
    IdentityApi,
    VerifyDomainResult,
    RemoveDomainResult,
    RotateKeyProof,
    RotateKeyOptions,
    RotateKeyResult,
} from './api/identity';
export {
    ACCOUNT_CATEGORY_IDS,
    MAX_ACCOUNT_CATEGORIES,
    SELECTABLE_ACCOUNT_CATEGORY_IDS,
    isSelectableAccountCategoryId,
    kindAcceptsAccountCategories,
} from './api/accounts';
export type {
    AccountsApi,
    AccountKind,
    AccountCategoryId,
    AccountRelationship,
    AccountRole,
    AccountMemberStatus,
    AccountMemberSource,
    AccountMember,
    AccountNode,
    ListAccountsOptions,
    CreateAccountInput,
    UpdateAccountInput,
    InviteAccountMemberInput,
    UpdateAccountMemberInput,
    TransferAccountOwnershipInput,
    AccountSuccessResult,
    SwitchAccountResult,
} from './api/accounts';
export type {
    AppsApi,
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
    RotateApplicationCredentialInput,
    ApplicationCredentialWithSecret,
    RotateApplicationCredentialResult,
    ApplicationUsagePeriod,
    ApplicationUsageSummary,
    ApplicationUsageByDay,
    ApplicationUsageByEndpoint,
    ApplicationUsageStats,
    PublicApplication,
    ConnectedApp,
    ConnectedMcpClient,
} from './api/apps';
export type { LinkedAccountsApi } from './api/linkedAccounts';
export type {
    AgencyApi,
    AccountCapabilityPolicy,
    AvailableCapabilityCatalog,
    CapabilityExecutionAuthorization,
    CreateDelegationGrantInput,
    DelegationCatalogBinding,
    DelegationGrantView,
    PutAccountCapabilityPolicyInput,
    RequesterAssertionGrant,
    RequesterAssertionIntrospection,
    UpdateDelegationGrantInput,
} from './api/agency';
export type {
    StoreApi,
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
} from './api/store';
export type {
    BillingApi,
    SubscriptionPlan,
    SubscriptionStatus,
    SubscriptionFeatures,
    Subscription,
    Payment,
    WalletTransactionType,
    WalletTransactionStatus,
    WalletTransaction,
    WalletPagination,
    WalletTransactionsPage,
} from './api/billing';
export { REPUTATION_CACHE_PREFIX } from './api/reputation';
export type { ReputationApi, ReputationPage } from './api/reputation';
export type {
    CivicApi,
    CivicCardResult,
    SubmitRealLifeAttestationInput,
    DenyValidationResult,
    VouchForPersonInput,
    WithdrawVouchResult,
    IssueCredentialInput,
    RevokeCredentialResult,
} from './api/civic';
export type { NodesApi, UserNodeStatus, UserNodeMode, UserNodeController, UserNodeLivenessStatus, RegisterNodeInput, RemoveNodeResult } from './api/nodes';
export { AccountNotOnDeviceError } from './api/devices';
export type { DevicesApi, UserDevice, SecurityInfo } from './api/devices';
export type { TopicsApi, TopicListOptions } from './api/topics';
export { OxyAppDataIdentifierError } from './api/appData';
export type { AppDataApi } from './api/appData';
export type { ContactsApi, ContactDiscoveryMatch, ContactDiscoveryResponse } from './api/contacts';

// ---------------------------------------------------------------------------
// "Sign in with Oxy" delivery helpers
// ---------------------------------------------------------------------------
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
// Domain models / wire types
// ---------------------------------------------------------------------------
export type {
    PrivacySettings,
    NotificationPreferences,
    UserPreferences,
    User,
    LoginResponse,
    Notification,
    NotificationActor,
    NotificationPage,
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
    coerceToSupportedLocale,
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
export { translate, loadLocale, isLocaleLoaded, subscribeLocales, getLocalesVersion } from './i18n';
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
    PASSWORD_REGEX,
    MAX_DISPLAY_NAME_LENGTH,
    DISPLAY_NAME_INVALID_MESSAGE,
    isValidEmail,
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
// Logging — the ecosystem-wide chokepoint (also at subpath `@oxy.so/core/logger`)
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

// The central IdP apex (`CENTRAL_IDP_APEX`, auto-allowed by `createOxyCors`)
// and the auth web origin. `registrableApex` / the official-origin checks
// (which ship the public-suffix list) are in `@oxy.so/core/server`.
export { AUTH_WEB_ORIGIN, CENTRAL_IDP_APEX } from './utils/authWebUrl';


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
export type { PkcePair, BuildOAuthAuthorizeUrlParams, OxyAuthScreen } from './utils/oauthPkce';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export { packageInfo } from './constants/version';
