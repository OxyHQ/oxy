/**
 * Allowed Origins — TRUSTED (credentialed) allowlist (MED-1 CSRF hardening).
 *
 * `isAllowedOrigin` is the single SYNCHRONOUS trusted-origin check shared by:
 *  - the credentialed CORS lane (config/cors.ts),
 *  - the CSRF Origin guard (middleware/originGuard.ts),
 *  - the Socket.IO CORS config (config/cors.ts).
 *
 * It is TRUSTED-ONLY and never widens to third-party app origins — that is the
 * exact CSRF / token-leak boundary we close. The trusted set is now sourced
 * from {@link dynamicOriginRegistry}: it is the union of
 *  - active first-party / internal / system / official Applications'
 *    `redirectUris` origins (auto-authorized by registering the app in Console),
 *  - validated `OXY_EXTRA_ALLOWED_ORIGINS` (emergency escape hatch),
 * with `http://localhost[:port]` / `http://127.0.0.1[:port]` / `http://[::1][:port]`
 * trusted UNCONDITIONALLY in ALL environments (including production) — an
 * approved posture so a developer's loopback dev server can make credentialed /
 * state-changing requests against prod (owner-approved).
 *
 * Registering a NEW first-party frontend now authorizes its origin
 * automatically via the Application registry — no code edit here. THIRD-PARTY
 * app origins are handled by `getCorsDecision`
 * (non-credentialed lane) in the registry — they are intentionally NOT visible
 * to `isAllowedOrigin`.
 */

import { isTrustedOrigin, getExtraAllowedOrigins } from './dynamicOriginRegistry';
import { isLoopbackOrigin } from '../utils/origin';

/**
 * Strict TRUSTED Origin allowlist check. Comparison is case-sensitive on
 * purpose: browsers always send lowercase scheme + host, so anything else
 * (`https://EVIL.oxy.so`, homograph hosts) is not a legitimate browser origin
 * for our zones.
 *
 * Reads the trusted snapshot from {@link dynamicOriginRegistry}; also honours
 * loopback dev origins (unconditionally, in ALL environments — owner-approved)
 * and the `OXY_EXTRA_ALLOWED_ORIGINS` escape hatch synchronously, so an env
 * change is reflected immediately rather than only after the next background
 * refresh.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (isTrustedOrigin(origin)) {
    return true;
  }

  if (isLoopbackOrigin(origin)) {
    return true;
  }

  return getExtraAllowedOrigins().has(origin);
}
