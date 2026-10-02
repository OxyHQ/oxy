# I11 final integration acceptance ledger

Owner: I11 / [oxy#1527](https://github.com/OxyHQ/oxy/issues/1527), coordinating [parent#1519](https://github.com/OxyHQ/oxy/issues/1519). Prepared 2026-10-02 on Oxy default head `4b145040afca38be93ad4096241d4c60e12e1c82`. **All integrated gates below remain pending.** This ledger preserves the full issue scope and is a verification plan, not an assertion that tests exist or passed. The [50-repository source matrix](../audits/2026-10-02-i11-ecosystem-coverage.md) records preparation completed separately.

Each executed gate must record repository/PR and exact head, packed package integrity when applicable, environment, command or request transcript, expected/actual result, timestamp, logs and rollback reference. “Passed”, source search, mocks, a fixture name, a skipped workflow step or another PR's unit suite cannot substitute for the gate's requested observation. Failed or missing evidence keeps the gate open. Test money/provider responses remain fixtures or sandbox operations unless explicitly authorized. Production rollout and final closure remain decisions for Nate.

## Identity, authority and consent (I01–I03)

- [ ] ID01 Human and bot both have complete subject/profile, account graph, roles and financial subject; role/permission logic does not branch into weaker bot checks.
- [ ] ID02 Autonomous bot sign-in uses the approved credential/governance/recovery/key lifecycle; bot membership, operator identity and financial subject remain distinct. Preparation of a bot actor DTO does not satisfy this.
- [ ] ID03 Real operated bearer survives direct authorize, both OAuth approvals, finalize and fresh PKCE exchange; human operator is retained while represented bot is subject. Revoking membership denies approval/finalize/exchange/validate/refresh, including warmed remote processes.
- [ ] ID04 Bot and human have equivalent account/resources/payment actions for equivalent grants; self-owned bot/governance/transfer/delete/recovery behavior matches approved policy. No perpetual creator privilege or orphaned signing keys are introduced.
- [ ] ID05 Cross-account resource ownership cannot be supplied through request fields/headers; changing subject cannot change operator or financial payer; socket rooms derive from verified socket user.
- [ ] ID06 Consent persists through one atomic transition for both OAuth entries. First grant and revoked grant × explicit/empty scopes × first-party/third-party produce the approved fallback behavior, with requested/allowed scopes and explicit special-capability consent.
- [ ] ID07 Failure while saving grant/revocation/code rolls back; replay and concurrent approvals spend exactly one code and create at most one authorized session. Returned subject mismatches fail closed.
- [ ] ID08 Session/grant/member/credential/application revocation and scope/resource/catalog changes invalidate authority at the approved freshness bound across processes and warm caches; measure an elapsed-time upper bound, not a local cache-clear illusion.
- [ ] ID09 ABA/recreated bindings, concurrent verification responses, clock skew/error paths, epochs/events/tickets and internal bypass assumptions follow the approved I03 guarantees. Positive/negative/error TTLs are measured separately.
- [ ] ID10 No user IP is persisted, including hashed/geo-derived forms; rate-limit keys use shared hashing. Secrets, TOTP recovery material, private key data and bearer proofs stay out of responses/logs.

## Shared HTTP/MCP transport and consumer parity (I04–I05/I11)

- [ ] MCP01 Published shared contracts/core/MCP tarballs expose the approved discriminated principal and `/server` proof surface; valid user/service/workload cases are distinguishable without client-supplied identity.
- [ ] MCP02 Internal invocation binds calling service, operator, served account, resource, tool, requested capabilities and catalog/version on every call; changing each binding or forging internal headers fails closed.
- [ ] MCP03 Live introspection/authority checks revoke access within approved policy. Wrong audience/origin/resource, expired/replayed proof, missing scopes and suspended application are denied; no first-party flag substitutes for proof.
- [ ] MCP04 External origin A token with active B serves only B after selection; resource ACLs in A and B remain enforced. Revoking B produces only the approved origin fallback or denial and cannot continue reading/writing B.
- [ ] MCP05 Execute the account-switch/resource/revocation matrix over both HTTP and MCP in Noted, Mercaria, website and **Oxy's Inbox backend**. The standalone Inbox repo is frontend-only; its obsolete issue path is not a migration target.
- [ ] MCP06 Alia and Mention use the published internal transport and shared authority contract; all relevant tools pass bot/human and HTTP/MCP parity with resource ownership. Repeated retries do not execute a non-idempotent tool twice.
- [ ] MCP07 Website non-admin tools still read through public REST only; active-account selection does not promote a principal to admin. Mercaria preserves store ACLs; Homiio/Sindi preserves explicit consent and pinned service identity.
- [ ] MCP08 External connectors retain registration, explicit user consent, scope/resource revocation and OAuth PKCE. `mercaria-woocommerce` remains a shop-scoped Channel API Key ingestion contract with wrong-store/revoked-key denial demonstrated.
- [ ] MCP09 No app-local authentication/token-provider/restore duplication is removed until the common replacement is adopted, source-compatible and exercised in that consumer. Record the deleted code and the replacement's package/version/artifact proof.

## Billing, products and payments (I06–I08)

- [ ] BILL01 Duplicate and out-of-order checkout/invoice/webhook events create one immutable award for the correct invoice/subscription/source/beneficiary; crashes before/after provider call and DB commit recover deterministically.
- [ ] BILL02 Subscription periods come from fully paginated recurring invoice lines: mixed prorations, multiple known prices, wrong periods, missing pages and ambiguous subscription items fail closed. Stripe mode/event version/SDK version and `invoice.paid` subscription preflight are verified in the approved environment.
- [ ] BILL03 P1–P3 match the approved commercial decision for mid-period changes, zero-amount periods and refunds; deterministic rational/rounding ordering, caps/reservations and repeated refund-before-award cases are demonstrated. Candidate proposals do not count as activated policy.
- [ ] BILL04 Product plans and Oxy One bundle use immutable offer/source/benefit segments. Upgrade preserves historical offer; cancel/end/change affects only the named product/subscription/source, with payer distinct from beneficiary.
- [ ] BILL05 Quota combination and duplicate benefits follow approved explicit rules. Unknown/unsupported composition fails closed; bundle cancellation cannot erase an independently purchased product entitlement.
- [ ] BILL06 Schema, constraints/migrations, repositories, backfill, API endpoints, contracts/core/services queries, Console UI and catalog are complete and exercised together. Historical plan/subscription IDs map explicitly; mixed legacy monthly balance is not reinterpreted as a new grant ledger.
- [ ] BILL07 Clarity credits stay delegated to Alia while local subscription product and exact subscriptionId retain their authority. Mercaria merchant billing stays separate from marketplace/payment/payout execution; cancellation of one product leaves the other active.
- [ ] BILL08 Console query/cache keys include subject/product/contract version and invalidate on access events. Account A cached subscription must never appear in account B; user plan and inference wallet remain distinct.
- [ ] BILL09 Privacy analytics consent survives purchase/cancel/backfill unchanged; explicit user intent is retained and no cancellation or plan migration activates analytics.
- [ ] PAY01 Peable published SDK has equivalent stable customer/checkout/portal/retrieveSubscription/cancelAtPeriodEnd/payment/refund/status/payout interfaces, exact request/response error DTOs and the consumers' required recurring semantics.
- [ ] PAY02 Mercaria custom client is replaced only after retry/idempotency/scopes/workload authentication and commercial-domain separation pass against the published SDK. Homiio rent flows retain equivalent payer/payee/owner/refund authority.
- [ ] PAY03 Provider errors/timeouts/retries and reconciliation have parity with the previous implementation; no silent provider switch or lost commercial state. Test/sandbox and live provider objects/modes cannot be mixed.
- [ ] PAY04 TNP's future Peable adoption remains planned and purchase blocked until a separately approved integration exists. This issue grants no registrar/fulfillment or purchase capability.

## Internal inference, usage and no double charge (I09–I10)

- [ ] INF01 Alia agent/chat routes Alia → Oxy → sole signed Kaana origin `https://kaana.ai`; one-shot product calls route Oxy → Kaana. Provider credentials exist only in Kaana; permanent Alia product API remains available.
- [ ] INF02 Approved internal service identity/scope/capacity/catalog reaches `internal_metered` without commercial reservation/charge between products. Wrong/unapproved principals cannot select internal treatment.
- [ ] INF03 Usage and cost are durable with request/attempt/deployment/rate-card provenance. Unknown historical units and partially known cost remain explicitly unknown, including real producer NULL fixtures; no empty-unit reinterpretation fabricates cost completeness.
- [ ] INF04 Streaming, success/failure/cancel, provider retry, Oxy restart and crash around terminal settlement lead to one terminal durable event and deterministic reconciliation; no lost usage or repeated settlement.
- [ ] INF05 Reconcile Kaana's real/sandbox producer feed with Oxy consumer attempts, including partial unknown units and failed/retried attempts. All page/cursor boundaries and exact internal identity filters are measured.
- [ ] INF06 Auto/Jev classifier calls and generation-status retrieval work for the internal treatment; classifier is not forced into the commercial lane. External scoped commercial behavior remains fail-closed and independently charged when applicable.
- [ ] INF07 No-double-charge ledger demonstrates the same request trace across Alia product charge, Oxy internal usage and Kaana provider cost: no second inter-product commercial charge and no duplicated provider attempt/settlement. Any user product charge retains its explicit contract.
- [ ] INF08 Product credits/limits and scoped commercial execution, grants/budgets/holds are not confused with internal metering. Unknown/unsupported models, rate cards or quota decisions fail closed, without hidden charging fallback.

## Web and Android SSO (I11)

- [ ] WEB01 Fresh origin with no first-party credential remains signed out until a real gesture. No cookies, FedCM discovery/runtime, hidden iframe, silent redirect or `prompt=none` restore exists in the served artifacts. Metadata removal alone does not prove runtime absence.
- [ ] WEB02 Browser bridge checks exact sender origin, expected window/opener, state, registered redirect and one-use join code; wrong origin/window/state/redirect, expired/replayed code and popup interception fail closed.
- [ ] WEB03 Popup and gesture-started redirect use the same state + PKCE completion; wrong verifier, returned subject mismatch, popup failure and stale handshake cleanup are exercised. SDK never starts an unsolicited top-level navigation.
- [ ] WEB04 Joined origins maintain independent holder credentials while sharing the browser's device state; one holder cannot rotate away the others. Account switch, one-account logout and all-account logout propagate with revisions and no stale account leak.
- [ ] AND01 Build and JVM/manifest guards actually execute for changed Android provider/plugin code; workflow success with skipped steps is insufficient. Verify published source and resulting APK signing/application ID/provider authority.
- [ ] AND02 On a real approved device, same-signature approved sibling adoption works; wrong-signature UID/provider access is denied, forged IPC/account selection is denied, and logout/account switch reaches siblings.
- [ ] AND03 Real identity survives storage read failures and sibling recovery: no UID-shared Keystore key deletion; recovery repairs only its own encrypted preferences. Commons identity pin remains tied to its owner.
- [ ] AND04 Real-device evidence records device serial/app versions/signatures/Hermes behavior and uses non-destructive operations. Never `pm clear`, Clear storage or uninstall Commons carrying a real identity. Pixel 8a `43221JEKB12200` is read-only unless further authorized; current preparation performs no device operation.

## Adoption, migration order and final closure

- [ ] REL01 Every relevant repo has refreshed accessible-set/default-head evidence, concrete affected/planned/unaffected classification and inspection depth; all 50 dated rows are reconciled with current changes. Source matrix preparation can complete separately from this final refreshed adoption gate.
- [ ] REL02 Each adopted repo proves declared range, lock resolution (all nested copies), package publication/integrity and deployed artifact/version separately. Legacy namespaces/examples and scaffold templates migrate or carry an explicit compatibility justification with measured behavior.
- [ ] REL03 The coordinated release covers I01/I04/I07 contracts/core/MCP once; CJS/ESM/types/native/optional-peer/package boundaries are checked on tarballs built in the same packing command. Published version notes document compatibility and breaking behavior.
- [ ] REL04a Existing typed `getGeneration(): Promise<OxyGenerationReceipt>` callers remain compatible; any new `getGenerationRecord()` method is tested against published tarball schema-v1/v2 behavior. No widened public return union is called additive solely because no local caller was found.
- [ ] REL04 Manifest+lock commits and genuine package test/build/typecheck scripts pass for every affected consumer; missing/no-op scripts have alternate measured acceptance. Consumer packed-package tests run without source mappings hiding missing exports.
- [ ] REL05 Recompose current identity/billing/inference heads on current main, regenerate rather than hand-mix schema snapshots/OpenAPI, renumber migrations in the actual accepted order and prove SQL identity, clean fresh DB plus upgraded DB behavior on an owned disposable instance.
- [ ] REL06 Guards, correct package suites/API shards and Android executed checks pass on the final composite. Security policy/advisory decision already pending in #1519 is resolved; no global skip/ACK or cosmetic green check substitutes for approved mitigation.
- [ ] REL07 Runbook40 and cutover configuration match the approved identity and environment. After rollout authorization, running PRIMARY deployment/image digest or APK/web artifact confirms adoption; a successful stable waiter may describe a rollback and is insufficient.
- [ ] REL08 Regression report records every gate above, source-vs-packed-vs-sandbox-vs-live scope, missing evidence and failed tests. Rollback is reviewed with prior package/artifact integrity, immutable financial grant/event reconciliation and key/authority preservation.
- [ ] REL09 All I01–I10 daughters satisfy their complete checklists with PR/commit, command, environment and results; no candidate unit count, omitted consumer or pending policy is treated as a completed daughter.
- [ ] REL10 I11 synchronizes its checklist and parent summary from verified evidence; Nate reviews the full result and decides parent closure. No automatic production deploy, merge/queue, publication, fund movement, credential or permission expansion occurs under this checklist alone.
