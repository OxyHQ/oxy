# ADR 0031 — Explicit OAuth consent and ordinary trusted fallback

- Status: accepted; implementation candidate for #1521.
- Date: 2026-10-03.
- Decided by: Nate's approval of the documented architecture recommendations:
  «te apruebo todo, y sobre tus preguntas, deberia estar todo explicado en la issue pienso yo...».
- Authority: [session record](../audits/1519-approved-completion-2026-10-03/authorization.txt).

## Decision

A third-party OAuth request must name scopes. An empty request fails with HTTP
400 and `invalid_scope`, before creating an authorization request or code.
A trusted application may omit scopes; its fallback is its registered scope set
minus **every** `USER_CONSENT_REQUIRED_SCOPES` entry. Being first-party, official
or internal does not substitute for explicit consent.

An explicit request keeps the existing registered-ceiling intersection. Unknown
or unregistered scopes are dropped; an explicit request whose intersection is
empty stays empty and never becomes a fallback. Registered empty sets stay empty.

`resolveOAuthScopes` is shared by request creation, approval information, the
consent screen and both code finalizers. Only explicit, carried
`acting-as:offline` may clear a prior refusal. Ordinary fallback creates no
consent-required grant and never clears a revocation. Grant persistence,
revocation clearing and code insertion retain their shared transaction.

## Compatibility and verification

This deliberately narrows the previous fallback: third-party callers omitting
scopes must send the scopes they need. Existing grants are not rewritten and
existing credentials are not rotated. Device sign-in without an OAuth binding
keeps its existing contract. ADR 0030 human sign-in is unchanged.

The [candidate evidence](../audits/2026-10-03-i02-approved-consent/README.md)
records real HTTP routes and SQL, scope UI parity, replay and transactional
failures. Production rollout and final I01/I03 acceptance remain separate.
