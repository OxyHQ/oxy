import { z } from 'zod';

/**
 * The two `/auth/oauth/*` responses the browser hub's edge layer reads.
 *
 * They existed on the wire long before this file — `GET /auth/oauth/consent`
 * and `POST /auth/oauth/authorize` are the surface `auth.oxy.so` has always
 * driven with a bearer. What is new (issue #937 Phase 5) is a SECOND consumer
 * that is not the SPA: the IdP's edge layer runs both calls server-side so the
 * device-wide bearer never enters the browser's script context. A shape read by
 * two independently deployed consumers is a contract, so it is written down
 * once here and validated on both sides rather than transcribed into the edge.
 *
 * These are NOT the RFC 6749 token/userinfo responses. Those two speak flat
 * OAuth/OIDC on the wire and are the one place in the API that does not use the
 * `{ data }` envelope; these two are ordinary internal API responses that happen
 * to be about OAuth.
 */

/**
 * Server-authoritative answer to "must this user be shown a consent screen".
 *
 * Discriminated on `consentRequired` so the two arms cannot be confused by a
 * consumer that reads `reason` first: `trusted`/`granted` are reasons NOT to
 * ask, `new`/`scope_changed` are reasons to ask, and a flat object would let a
 * typo in one produce a plausible value of the other.
 *
 *  - `trusted`       — the application is first-party/internal/system/official
 *                      by the REGISTRY's verdict (`isTrustedApplication`), and
 *                      the request names no scope over the user's own follow
 *                      graph. Never inferred from a hostname.
 *  - `granted`       — a prior `AppGrant` already covers every requested scope.
 *  - `scope_changed` — a prior grant exists and is missing one.
 *  - `new`           — no prior grant.
 *
 * `userConsentScopes` names the scopes that FORCED the screen, so the consent UI
 * can say which one it is asking about. Present only on the `true` arm, and only
 * when such a scope exists — a trusted app asked for one is still asked.
 */
export const oauthConsentDecisionSchema = z.discriminatedUnion('consentRequired', [
  z.object({
    consentRequired: z.literal(false),
    reason: z.enum(['trusted', 'granted']),
  }),
  z.object({
    consentRequired: z.literal(true),
    reason: z.enum(['new', 'scope_changed']),
    userConsentScopes: z.array(z.string()).optional(),
  }),
]);

/**
 * A minted authorization code.
 *
 * `state` is echoed back as the caller sent it and is `null` when they sent
 * none — never omitted, so a consumer cannot read "the server dropped my state"
 * as "I sent none". `redirectUri` is echoed for the same reason the code is
 * bound to it server-side: the caller must be able to see that the value the
 * code was issued against is the one it registered.
 */
export const oauthAuthorizeCodeResponseSchema = z.object({
  code: z.string().min(1),
  state: z.string().nullable(),
  redirectUri: z.string(),
  expiresIn: z.number().int().positive(),
});

export type OauthConsentDecision = z.infer<typeof oauthConsentDecisionSchema>;
export type OauthAuthorizeCodeResponse = z.infer<typeof oauthAuthorizeCodeResponseSchema>;
