/**
 * @oxyhq/core/server — Server-only utilities for Oxy backends
 *
 * This subpath export provides Express middleware and Node.js-specific
 * utilities that are not available in React Native or browser environments.
 *
 * @example
 * ```ts
 * import { createOxyRateLimit } from '@oxyhq/core/server';
 * import { oxyClient } from '@oxyhq/core';
 *
 * const oxy = oxyClient({ apiUrl: 'https://api.oxy.so' });
 *
 * app.use(createOxyRateLimit(oxy, { store: redisStore }));
 * ```
 */

export {
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
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
export type {
  OxyAuthenticatedRequest,
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

// Constant-time secret comparison.
export { verifySecret } from './verifySecret';

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
// client mixins and this Node-only subscriber sweep the SAME list — a second
// copy is what let `updateAccount` and `updateProfile` drift apart.
export { evictOxyIdentityCache, oxyUserByIdCacheKey, OXY_IDENTITY_CACHE_PREFIXES } from '../utils/identityCacheSweep';
export type { OxyIdentityCacheEvictor } from '../utils/identityCacheSweep';

// Registrable-apex (eTLD+1) derivation via the Public Suffix List — the SINGLE
// SOURCE OF TRUTH shared with the IdP worker and the client FAPI auto-detect.
// Pure host handling (no browser deps), so it is safe on the server subpath and
// lets `@oxyhq/api` derive `auth.<apex>` without duplicating PSL logic.
export { registrableApex } from '../utils/registrableApex';
export { isOfficialWebOrigin } from '../utils/officialOrigins';
