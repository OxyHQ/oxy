# Published client compatibility during the first-party rollout

Checked against npm tarballs on 2026-10-23: `@oxy.so/core@6.15.1`,
`@oxy.so/services@12.12.0`, `@oxy.so/contracts@5.7.0`, with the earlier
`core@6.0.0` and `contracts@5.0.0` as a baseline. This checks released JavaScript,
not just source built together with the new API.

| Surface | Published behavior | Release requirement |
| --- | --- | --- |
| Public client metadata | Contracts `dist/cjs/client/sessionStatus.js` requires `application.scopes`; Services `src/ui/oauth/applicationSessionLane.ts` parses it before choosing the shared-device lane. | Keep this real external OAuth/API-key ceiling metadata. It is not authority for an own workload or user session. |
| Approval information | Core `dist/esm/api/auth.js` returns `raw.scopes` without a default. The API continues to return an empty array for own approval information. | Keep this compatibility projection while older approval clients remain deployed; never fabricate permissions. |
| OAuth consent | The published `oauthConsentDecisionSchema` already accepts `{consentRequired:false,reason:'trusted'}`. | Own approval can skip consent without changing the response schema. External consent retains scopes and grants. |
| OAuth token exchange | Published Core `exchangeCode` reads the access token, session, device extras, expiry and user; it never requires `scope`. | An own response may omit `scope`. The device/session fields must remain. External `scope` remains the granted intersection. |
| Consent presentation | Services 12.12 `OxyConsentScreen` iterates `scopes`; an empty array displays `consent-scope-basic`. `explicitOAuthConsent` still checks application scopes. | Roll out the updated own sign-in UI and stop own callers from invoking explicit scope consent before declaring the fleet complete. Changing the API alone does not remove old permission UI. |

The actual CommonJS parsers from both Contracts 5.0.0 and 5.7.0 were executed
with the same official application fixture. Omitting `scopes` rejected it;
`scopes: []` and `scopes: ['files:read']` both parsed. The new API's
`serializePublicApplication` preserves the real field, and `/approve-info`
preserves its own empty compatibility array. Do not remove public application
metadata to work around an app's obsolete own feature gate: remove that gate in
the consuming app (including own AI gates) and retain metadata for external OAuth.

Before the final cutover, verify cold boot, shared-device restoration, email/QR
sign-in and own approval in the deployed app versions, and external OAuth consent
and isolated session exchange. Only retire an obsolete own approval field after
its actual consumers no longer require it. This does not authorize removing
external scope contracts.
