# Oxy One personal draft

Draft source implementation only. No offer, provider, price, entitlement or subscription was activated. No provider request, deployment, push or PR is part of this work.

## Architecture and first slice

`BILLING_PRODUCT_CATALOGUE_FILE` remains the one server-owned catalogue of product registrations, frozen offer versions, benefits and provider price bindings. Optional `personalPlans` entries publish reviewed versions; they do not create grants. Each entry names `offerId`, `offerVersion`, `displayName`, `audience: personal`, `kind: oxy_one` and ordered `benefitNames` matching the frozen benefits. All entries require a registered nonempty bundle and exclude API credits. The default is an empty publication list. Consumer copy comes from this catalogue, not a second Website pricing table.

Public `GET /billing/personal-plans` returns `PersonalPlanCatalogue` through `oxy.billing.personalPlans()` and `usePersonalPlans()`. It exposes friendly benefit names and exact versioned benefit contracts, without owners, application IDs, provider IDs, payer data or prices. `state` is `unconfigured` for an empty list; `purchase` is always `unavailable`. This is distinct from the pre-existing `/billing/plans` API-credit catalogue.

Accounts `/payments` adds Oxy One discovery and all current-account product subscription sources. The existing legacy subscription remains visible. Sources and historical offer segments remain distinct. Cancellation selects one source, requires in-app confirmation and uses the existing payer-only Stripe adapter. Pending reconciliation is reported separately from completed local projection. Peable sources have no cancellation CTA. Reads include `expectedSubjectAccountId`; wrong-account requests fail with 403. The new query namespace is not persisted; account and session partition its cache. Account switches reset confirmation state.

## Storage integration and limits

The baseline direct upload path had per-file validation and deduplication but no account-wide quota check. Legacy displayed 15 GiB/2 TiB/5 TiB values were usage metadata, not proof of admission enforcement.

The optional catalogue `storageAdapter` is null by default. Its explicit contract is `{ productId, quotaKey, unit: "byte", legacyCombination: "maximum" }`; the product must be registered. When configured, storage reads effective immutable product grants and preserves the legacy limit as a floor. Individual and bundle sources remain independent. Conflicting rights or units fail closed. No product ID or bundle quantity is assumed.

Configured repository writes enforce **metadata admission** for original reservations, size/status corrections, and single/batch variant replacements. Account advisory locks serialize quota-increasing writes; an over-limit mutation rolls back. Original and known variant sizes count for active and trash rows. Deletions release metadata reservations; reductions and unchanged usage remain possible after a downgrade. The usage endpoint reports `quotaEnforcement` and decimal-string `reservedBytes`, separate from the existing active-file breakdown.

This is not a hard bound on S3 physical bytes. Presigned upload Content-Length verification/repair, rejected rendition object cleanup, abandoned upload reservation cleanup, and administrative owner-split migration behavior need dedicated end-to-end work before activating this adapter. Background generation may have written an object before metadata admission rejects its variant. Existing behavior is unchanged when the adapter is null. Legacy subscription billing resolution is preserved, including its existing billing-first semantics.

## Alia handoff (repository absent)

1. Register the actual Alia product/application owner and exact product access audience; do not infer IDs from a brand name. Use existing OxyServer middleware and the production application-bound user session.
2. For each user request, resolve `oxy.billing.productAccess({ schemaVersion: 1, subjectAccountId, productId })`. The subject must be the authenticated user's active account. Do not use public catalogue visibility as access authority; never persist a cross-account answer.
3. Agree exact quota keys/units, benefit combination and renewal periods before configuration. Alia must translate composed rights into its own plan-access gate and durable consumption ledger; central grants alone do not activate Alia.
4. Preserve individual Alia subscription provenance and daily-replenishment mechanics. Monthly/daily budgets must not be converted to provider invoice cost; system prompts are a separate cost. No values from seed plans or tentative economics are commercial defaults here.
5. Consumption must be atomic, account/period/source scoped and idempotent per request. Test replay, concurrent exhaustion, individual+bundle coexistence, cancellation at period end, expiry, refunds and account switches. Return remaining usage from that ledger. This repository exposes rights, not an Alia credit ledger or usage endpoint.

## Website handoff (repository absent)

Add `/one` and a public navigation/product entry in `OxyHQ/website`, using its existing Oxy/Bloom assets. Fetch the shared public read-model via SDK. Render the exact published benefits/versions and an honest unavailable state. Route account management to Accounts `/payments`; do not manufacture checkout URLs. Do not hardcode price, currency, quota, family/team scope, exclusive models, verification or mail benefits in CMS/editorial content. Network errors differ from an intentionally empty catalogue.

## Commercial and launch gates

Price, currency, approved quotas, provider choice and billing cadence remain unsettled. Consumer bundle checkout and server-side authoritative price/offer selection are not implemented; the API-credit checkout remains separate. Provider products/prices, catalogue activation, legal acceptance and payments require a separate authorized task. Stripe cancellation support does not imply Peable support. Publish/PR/merge/deploy authorization is not granted.

## Validation

Repository-mandated package `bun run test` scripts are used; API suites provision and drop throwaway PostgreSQL databases on the local development server. Provider webhook suites mock Stripe. New tests cover public projection/defaults/version checks, SDK parsing/uncached reads, expected-account fencing, late account-switch results, confirmation reset, cancellation pending state, concurrent storage reservations, original+variant totals, rollback, account isolation and individual+bundle coexistence. Existing provider-evidence and webhook suites cover replay, renewal, source cancellation/expiry and grant provenance. Build/typecheck results and exact test totals are in the implementation handoff; no production reachability or external repository completion is inferred from local checks.

Verified locally on this draft:

- Contracts and Core builds passed (CJS, ESM, declarations).
- Services build and package-export verification passed; Services, API and Accounts TypeScript checks passed.
- API: 139 tests across 10 targeted suites passed. The expanded downgrade/storage test then passed again (5 storage tests).
- Core billing SDK: 12 tests passed.
- Services account-switch hook: 1 test passed.
- Accounts confirmation/account-switch UI: 2 tests passed; its 2 edge checks also passed.
- `validate:agents-md` and `git diff --check` passed.
- Superdesign preflight worked but was unauthenticated; no login or generation was attempted.
- Bun 1.4.2 was missing from PATH. A temporary npm-fetched runtime in `/tmp/oxy-bin` enabled the required scripts; dependency manifests and lockfiles were not changed.
- Accounts web export passed (37 HTML pages). Expo's initial cache write outside the workspace failed; retry used a `/tmp` Expo cache with telemetry disabled/offline mode, without changing HOME or credentials. Native OTA certificate warnings were existing build warnings; no native binary was built or published.
- Biome lint with `--error-on-warnings` passed for the five new implementation modules. Storage and Accounts interaction suites passed again after lint repairs.

## Continuation: visible draft and checkout lifecycle

Public Website and Alia repositories were fetched without credentials and placed
on separate `draft/oxy-one-personal-20261005` branches. Website adds `/one`, a
pricing-page entry, shared SDK catalogue reads, unconfigured/error states and an
Accounts link. English and Spanish copy are implemented; other locale keys use
explicit English fallback pending translation review. Website TypeScript build
passes using the locally compiled Core/Contracts copied into ignored installed
package directories; release requires publishing those SDK packages first.
No dependency manifest points to this private workspace.

Desktop/mobile Website screenshots were captured with existing system Chromium.
No horizontal overflow was observed. Accounts screenshot renders the actual
PersonalPlansCard/Section/ThemedText through a temporary harness with synthetic
account hooks and blocked network/mutations; it is component visual QA, not a
logged-in end-to-end session. Full Accounts export exists from the first draft.
Local preview servers are not public/deployed URLs.

Consumer checkout now has strict request/result SDK contracts, an additive draft
migration and durable subject/namespace/idempotency intent storage. Exact offer
version and price selection are server-owned. The HTTP route has no provider
adapter and remains unconfigured. Only synthetic test injection is allowed under
NODE_ENV=test. Browser completion grants nothing. Trusted immutable paid evidence
binds the checkout intent in its evidence hash, validates all ownership/selection
fields under lock, and fulfills atomically with the existing grant period. Frozen
selection is used for retries after catalogue changes. Only an exact trusted
terminal-session observation releases a pending checkout; no clock-only expiry
or browser-controlled release is exposed. A production provider adapter and
provider metadata propagation remain deliberately unwired.

Independent review identified and prompted repairs to storage ownership races,
owner-split copied variant admission, immutable checkout attribution, frozen
retry selection and terminal session release. Configured upload completion reads
HEAD bytes rather than trusting the client size. This improves metadata admission;
it does NOT enforce hard physical bucket usage: presigned uploads precede
completion and reusable PUT URLs can overwrite afterward. Staging/object version
admission, rejection cleanup, orphan accounting and an overwrite-proof upload
protocol remain required before claiming physical quota enforcement.

Validation of this continuation: checkout+paid-evidence 22 tests passed;
storage/file/asset suites 17 tests passed; Contracts/Core builds and API TypeScript
passed. Website `tsc -b` passed with local SDK validation arrangement and canonical
internal-link check passed. Website routing check requires a completed dist build,
which is not available in this slice; full production build/prerender was not run.
Alia install stopped at an unauthenticated GitHub dependency tarball HTTP 403.
Its exact access/consumption adapter handoff is in Alia docs; no runtime integration
or bundle credit activation is claimed. No push, PR, deploy, production migration,
provider product/price creation, credentials or payment activation occurred.

## Approved composition and tested benefit plumbing (continuation)

User approved Alia Pro-level **10,000 monthly credits**, existing daily free
refill preserved, and **100 GB decimal** (100,000,000,000 bytes). The detached
`packages/api/config/drafts/oxy-one-personal.template.json` contains those
benefits with explicit registered-identity placeholders and empty prices and
subscriptions. No runtime points at it; live publication is still unapproved.

Oxy now exposes an access-only active-grant-period snapshot behind the same live
subject/application/product boundary as product access. The SDK's request-scoped
server method forwards each validated user session without changing a shared
client token, with caching and retries disabled. Snapshot validation checks exact
active grant IDs, periods and quota composition. This is not a financial balance.

Alia's isolated branch now implements period-scoped product credit allocations
and links them to its existing immutable credit operations and price books.
Configured metered chat can fall back to bundle credits after existing daily/free
and individual paid sources are insufficient. Replay never refills a grant;
concurrent reservations conserve quantity; renewal uses a new period identity;
cancellation/expiry stop new reservations; refunds return to the same source.
Extra settlement beyond the admitted amount requires fresh Oxy authority.
Recovery without it is limited to the already reserved amount. No unrestricted
paid balance top-up is performed. A configured existing plan ID controls the
rolling window and does not reduce a larger existing individual plan window.
Overlapping bundle allocations fail closed pending an explicit upgrade policy.

This is metered-chat funding integration, not complete Alia consumer UI or all
background/voice/show credit lanes. Alia's ordinary plan/balance screens still
need the plural bundle read model. Its full install remains blocked by libsignal
from `@whiskeysockets/baileys` at the exact GitHub tarball revision bcea72d
(HTTP 403). Installed supported tools ran focused tests; no dependency substitute
or denial bypass was used. Local SDK builds were copied into ignored installed
package directories for validation; compatible SDK publication remains a release
gate and no private-path manifest dependency was committed.

Current verification: Oxy storage/access suites 35 tests passed; new SDK
request-session isolation test passed; Alia 39 database tests passed plus its
26-test billing-separation suite, and API typechecks passed. Alia lint reported
0 errors and 409 existing warnings. Website production Vite build passed,
offline-fallback prerender wrote 3,275 routes with 0 failures, and routing contract
validated 95 declared routes. A production-browser test covers empty and clearly
labelled synthetic configured catalogues, approved benefit layout, 100 GB decimal,
Accounts handoff, disabled checkout and desktop/mobile overflow. Existing Bloom
version was retained. No full CMS/integration production validation is claimed.

Storage's original/variant metadata admission and actual HEAD correction are
proven, including exact 100 GB and concurrent/downgrade cases. Hard physical bucket
usage remains a release blocker: reusable PUT URLs, orphan cleanup and variant
write-before-admission need a coordinated storage protocol change and bucket/CORS
validation. No claim that this draft enforces every physical byte is made.
