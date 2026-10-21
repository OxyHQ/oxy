/**
 * @oxy.so/core/server — Server-only utilities for Oxy backends
 *
 * This subpath export provides Express middleware and Node.js-specific
 * utilities that are not available in React Native or browser environments.
 *
 * @example
 * ```ts
 * import { OxyServer, createOxyAuthMiddleware, createOxyRateLimit } from '@oxy.so/core/server';
 *
 * const oxy = new OxyServer({ baseURL: 'https://api.oxy.so', serviceAuth: { apiKey, apiSecret } });
 *
 * app.use(createOxyRateLimit(oxy, { store: redisStore }));
 * app.use('/api', createOxyAuthMiddleware(oxy));
 * ```
 */

// The backend client: OxyServices plus the service-token lane, middleware,
// account events and the service-only namespace methods.
export {
  OxyServer,
  ServiceCredentialMismatchError,
  ANONYMOUS_SERVICE_TOKEN_RETRY_MS,
  DEFAULT_SERVICE_TOKEN_AUDIENCE,
} from './OxyServer';
export type { OxyServerConfig, ServiceTokenAudience, ServiceTokenResponse } from './OxyServer';
export {
  ServerAccountsApi,
  ServerAppsApi,
  ServerAgencyApi,
  ServerAssetsApi,
  ServerLinkedAccountsApi,
  ServerNotificationsApi,
  ServerReputationApi,
} from './namespaces';
export { ServerSafetyApi } from './safety';
export { ServerSessionApi } from './session';
export type { ServerSessionValidateOptions } from './session';
export {
  createOxyAliaMachineCredentialAuth,
  getOxyAliaMachineCredentialBearer,
  isOxyAliaMachinePrincipal,
  OXY_ALIA_RESOURCE_APPLICATION_ID,
  OXY_ALIA_MACHINE_SCOPES,
} from './aliaMachineCredential';
export type {
  AliaMachineCredentialIntrospection,
  OxyAliaMachinePrincipal,
  OxyAliaMachineRequest,
  OxyAliaMachineCredentialHost,
} from './aliaMachineCredential';
export type {
  CapabilityTicketGrant,
  CapabilityTicketIntrospection,
  CreateExecutionAuthorizationInput,
  ServiceCapabilityCatalog,
  ServiceUploadBody,
  ServiceUploadDescription,
} from './namespaces';
export { OxyAccountEventError, OXY_ACCOUNT_DELETED_EVENT_URI } from './middleware';
// Application roles: the app's own permissions, held by people, decided in Oxy.
export {
  APP_PERMISSIONS_CACHE_TTL_MS,
  OxyAppPermissionError,
  appPermissionErrorStatus,
} from './appPermissions';
export type {
  AppPermissionsOptions,
  OxyAppPermissionDenyStatus,
  OxyAppPermissionErrorCode,
  OxyAppPermissions,
  RequireAppPermissionOptions,
} from './appPermissions';
export type {
  AuthMiddlewareOptions,
  OxyAccountEvent,
  OxyAccountEventFeedItem,
  OxyAccountEventFeedPage,
  OxyMiddleware,
  ServiceActingAsVerification,
  ServiceApp,
  VerifyAccountEventOptions,
} from './middleware';
export {
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  getOxyActor,
  getOxyAuthRefusal,
  getOxyBillingPrincipal,
  getOxyDelegatedUserId,
  getOxyRequestAttribution,
  getOxyUserId,
  getRequiredOxyBillingPrincipal,
  getRequiredOxyUserId,
  isOxyAuthenticated,
  requireOxyAuth,
  OXY_SERVICE_ENVIRONMENTS,
} from './auth';
export type { OxyAuthHost } from './auth';
export type {
  OxyAuthenticatedRequest,
  OxyAuthRefusal,
  OxyAuthMiddlewareOptions,
  OxyAuthRequest,
  OxyBillingPrincipal,
  OxyRequestAttribution,
  OxyRequestUser,
  OxyServiceActingAsContext,
  OxyServiceAppContext,
  OxyServiceEnvironment,
} from './auth';
export { createOxyRateLimit } from './rateLimit';
export type { OxyRateLimitOptions } from './rateLimit';

// The real client address behind the ALB and, for a proxied hostname,
// Cloudflare: `app.set('trust proxy', oxyTrustProxy)` (Node-only).
export {
  CLOUDFLARE_IPV4_RANGES,
  CLOUDFLARE_IPV6_RANGES,
  isCloudflareAddress,
  isPrivateProxyAddress,
  oxyTrustProxy,
  resolveClientIp,
} from './clientIp';

// SSRF-safe upstream fetch + URL validation (Node-only).
export {
  assertSafePublicUrl,
  isBlockedIp,
  safeFetch,
  SsrfRejection,
  UpstreamError,
  ALLOWED_PORTS,
  ALLOWED_PROTOCOLS,
  BLOCKED_HOSTNAMES,
  DEFAULT_USER_AGENT,
  MAX_REDIRECTS,
  MAX_URL_LENGTH,
  UPSTREAM_HEADERS_TIMEOUT_MS,
} from './safeFetch';
export type {
  SafeFetchOptions,
  SafeFetchResult,
  SsrfCheckFail,
  SsrfCheckOk,
  SsrfCheckResult,
} from './safeFetch';
// Its body half: a byte cap and a whole-body deadline for every read (Node-only).
export { readResponseBody, readResponseJson } from './readResponseBody';
export type {
  ReadResponseBodyOptions,
  ReadResponseBodyResult,
  ReadResponseJsonResult,
} from './readResponseBody';

// Receiving Oxy's file events (ADR 0043 D9): signature + replay window.
export {
  FILE_EVENT_DEFAULT_TOLERANCE_SECONDS,
  FILE_EVENT_SIGNATURE_HEADER,
  FILE_EVENT_TYPES,
  FileEventVerificationError,
  verifyFileEventSignature,
} from './fileEvents';
export type { FileEvent, FileEventType, FileWebhookChallenge } from './fileEvents';
// Authorizing a play session's content key (ADR 0043 stage 4c), same signature.
export {
  STREAM_KEY_AUTHORIZATION_EVENT_TYPE,
  StreamKeyAuthorizationVerificationError,
  verifyStreamKeyAuthorization,
} from './streamKeyAuthorization';
export type {
  StreamKeyAuthorizationAnswer,
  StreamKeyAuthorizationRequest,
} from './streamKeyAuthorization';
export { LargeUploadFailedError } from './largeUpload';
export type {
  LargeServiceUploadOptions,
  LargeServiceUploadResult,
  LargeUploadProgressEvent,
  LargeUploadSession,
  LargeUploadSource,
} from './largeUpload';

// Strict CORS allowlist (Oxy apex family + explicit app origins).
export { createOxyCors } from './cors';
export type { OxyCorsOptions } from './cors';

// Shared Helmet + Content-Security-Policy baseline (Cloudflare Insights beacon,
// Oxy API/CDN origins) with additive, per-app extensions.
//
// `extractInlineScripts` / `inlineScriptCspHash` / `cspSourcesFor` are exported
// so a post-deploy gate can ask the SERVED document and the SERVED policy the
// same questions `buildOxyPagesHeaders` asked the built ones. A gate that
// re-implemented the scan or the parse would be testing its own copy, and would
// agree with a broken original.
export {
  buildOxyCspDirectives,
  buildOxyPagesHeaders,
  createOxySecurityHeaders,
  cspSourcesFor,
  extractInlineScripts,
  formatOxyCspPolicy,
  inlineScriptCspHash,
  OXY_CSP_BASELINE,
} from './securityHeaders';
export type {
  OxyCspDirective,
  OxyCspExtensions,
  OxyPagesHeadersOptions,
  OxySecurityHeadersOptions,
} from './securityHeaders';

export {
  CapabilityTicketError,
  createCapabilityTicketMiddleware,
  inputSatisfiesCapabilityLimits,
  issueCapabilityTicket,
  readCapabilityAuthorization,
  verifyCapabilityTicket,
} from './capabilityTicket';
export type {
  CapabilityTicketMiddlewareOptions,
  CapabilityTicketRequest,
  CapabilityTicketSigningOptions,
  CapabilityTicketVerificationOptions,
} from './capabilityTicket';

// The Oxy-published Ed25519 key set short-lived Oxy tokens are verified against.
export { createOxyJwksKeyResolver } from './jwks';
export type { OxyJwksKeyResolverOptions } from './jwks';

// App assertions (ADR 0045): which Oxy app a request comes from.
export {
  OXY_APP_ASSERTION_DEFAULT_ISSUER,
  OxyAppAssertionError,
  oxyAppAssertionClaimsSchema,
  readAppAssertionHeader,
  readOxyAppAssertionKeyId,
  signOxyAppAssertion,
  verifyAppAssertion,
  verifyOxyAppAssertion,
} from './appAssertion';
export type {
  OxyAppAssertionClaims,
  OxyAppAssertionErrorCode,
  OxyAppAssertionSession,
  OxyAppAssertionVerificationOptions,
  VerifiedAppAssertion,
  VerifyAppAssertionOptions,
} from './appAssertion';

// Constant-time secret comparison.
export { verifySecret } from './verifySecret';
export { createLiveCapabilityTicketVerifier } from './liveCapabilityTicket';
export type { LiveCapabilityTicketVerifierOptions } from './liveCapabilityTicket';

// Cross-service user-invalidation signal: oxy-api publishes when identity
// changes, every consuming backend sweeps its caches instead of waiting out a TTL.
export {
  createOxyUserInvalidationHandler,
  publishOxyUserInvalidation,
} from './userInvalidation';
export type {
  OxyInvalidationPublisher,
  OxyUserInvalidationHandlerOptions,
} from './userInvalidation';
// The identity-key enumeration itself is platform-neutral (`src/utils/`) so the
// client namespaces and this Node-only subscriber sweep the SAME list — a second
// copy is what let `updateAccount` and `updateProfile` drift apart.
export {
  evictOxyIdentityCache,
  oxyUserByIdCacheKey,
  OXY_IDENTITY_CACHE_PREFIXES,
} from '../utils/identityCacheSweep';
export type { OxyIdentityCacheEvictor } from '../utils/identityCacheSweep';

// Registrable-apex (eTLD+1) derivation via the Public Suffix List — the SINGLE
// SOURCE OF TRUTH shared with the IdP worker and the client FAPI auto-detect.
// Pure host handling (no browser deps), so it is safe on the server subpath and
// lets `@oxy.so/api` derive `auth.<apex>` without duplicating PSL logic.
export { registrableApex } from '../utils/registrableApex';
export {
  isLoopbackOrigin,
  isOfficialWebOrigin,
  isAllowedDeviceJoinOrigin,
} from '../utils/officialOrigins';

export { createEcosystemTraffic } from './traffic';
export type { EcosystemTrafficOptions } from './traffic';

export { observeNodeHttp, withoutNodeHttpObservation } from './trafficNodeHttp';

/**
 * Workload identity (ADR 0026): a first-party service asks Oxy for a service
 * token by proving what it IS, with no api key and no secret. Server-only, and
 * exported from this subpath rather than the root barrel because it reaches the
 * container credentials endpoint.
 */
export {
  attestWorkloadIdentity,
  canAttestWorkloadIdentity,
  requestWorkloadServiceToken,
} from './workloadIdentity';
export type {
  WorkloadAttestation,
  WorkloadServiceToken,
  WorkloadServiceTokenOptions,
} from './workloadIdentity';

export {
  OXY_SERVICE_TOKEN_MAX_LIFETIME_SECONDS,
  hasBoundedServiceTokenLifetime,
} from './serviceTokenLifetime';
export { signInAgentAccount } from './agentAccount';
export type { AgentAccountSigner } from './agentAccount';
