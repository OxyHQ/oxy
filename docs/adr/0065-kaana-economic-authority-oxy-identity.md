# ADR 0065 — Kaana owns inference economics; Oxy supplies identity

- Direction: **accepted by the owner, 2026-11-13**: Kaana processes inference,
  authorizes spending and invoices; Oxy keeps identity. This confirms the
  November 12 direction recorded in Kaana ADR 0010.
- Implementation below: **candidate, not deployed**. Canonical identity contracts
  8.13 and session extension 8.14 are merged and published; endpoint activation
  and financial cutover remain separate. Existing
  Oxy-issued grants, reservations and financial records remain authoritative
  until an explicit migration transfers their responsibility.
- Counterpart: [Kaana ADR 0010](https://github.com/OxyHQ/Kaana/blob/main/docs/adr/0010-kaana-sells-and-invoices.md).
- Supersedes the destination of inference financial authority in ADRs 0005,
  0006, 0009, 0014 and 0038. Their accounting invariants remain requirements;
  this does not declare their current implementation retired.

## Decision and current gap

Inference payloads go from the product to Kaana. Oxy supplies authenticated
identity. Kaana owns the inference catalogue and
power levels, routing policy, provider selection, prices, funding restrictions,
capacity, spend authorization, holds, settlement, customer balances, receipts
and invoices. Product tools and person-data authorization remain with their
existing owners. Gemies product credits are separate from Kaana's upstream
inference ledger.

At reviewed Oxy `4e5175e2a63cffcef9c50c23f590174a2b452f69`, the public Kaana
lane already keeps payloads out of Oxy. It still calls Oxy's
`/internal/kaana/v1/authorizations` and `/settlements`; Oxy authenticates,
qualifies models and prices, reserves and settles. Changing a caller's URL
does not remove that financial authority. The owner's accepted ADR 0010 direction assigns inference policy and spending
decisions to Kaana, not Oxy; older proposed identity-and-policy grants do not
define the new boundary.

## Canonical identity-only contract

The separate `POST /internal/kaana/v1/identities` operation uses the canonical
Kaana contract (`@kaana.ai/contracts/internal`). Only Kaana's live, first-party
workload authenticated for `oxy-api:kaana-control` may call it. The existing
economic authorization and settlement endpoints keep their behavior for legacy
admissions.

The strict version-1 request carries `kind: "identity"`, a correlation
`requestId`, audience `kaana.ai`, the caller's bearer and optional
`onBehalfOfUserId`. It carries no prompt, tools, model, quantities, prices,
credit, balance or requested economic treatment. The signed response contains:

- the authenticated application, credential/workload attribution handle, owner
  account, environment and credential lane;
- `first_party` authority without scopes, or `external` authority with the
  credential's verified inference scopes; a machine key remains external even
  when its application is internal;
- the live application class and `applicationIsInternal`, without deriving any
  financial classification;
- for workloads and machine keys, optional `userId` is **attribution only**:
  an arbitrary supplied ID is not a verified person, a payer override or
  permission to access that person's data.

The session extension adds a separate `authority: "session"`,
`lane: "product_session"` variant. It carries `applicationOwnerAccountId`
explicitly, without choosing that account as payer, and `verifiedRequester`
keeps the subject account distinct from the acting principal. The existing
session verifier checks the live session and context binding. Its
`applicationBinding` distinguishes an application-bound session, a verified
platform application token and a shared session presented with a public client
ID. That last ID is only application attribution, not app authentication.
There are no artificial scopes or workload authority on a session assertion.

A session's `userId` comes from its verified subject; `onBehalfOfUserId` must
be absent or match it. The request uses the existing bearer presentation, with
no new client-selected principal fields. The legacy session grant wrapper
retains its existing economic eligibility and per-person bounds. Identity
verification does not consult those terms; Kaana decides admission after
identifying the credential lane. Authentication failures never cause fallback
to another financial authority. Account hierarchy facts are not included in
this phase.
The response binds the exact identity-request bytes by SHA-256, its request ID
and audience, expires within 60 seconds, and uses the distinct signature domain
`oxy-kaana-identity:v1`. There is no inference payload digest in this identity
operation: Kaana binds its own inference request to its durable admission.

The assertion has no routes, model allowlist, prices, funding tier, capacity,
reservation, balance, `internal_metered` classification or spend permission.
It is not an inference grant. Shared bearer authentication is extracted from
`inferenceEdge.service.ts` without changing the legacy path. It preserves live
credential, workload-binding, owner, environment, audience and revocation
checks. There is no new identity cache or dependency on pilot eligibility,
model qualification or financial services.

## One financial authority for each admission

A new Kaana admission must persist its financial authority and idempotency
binding before provider execution. Its key includes authenticated application,
credential, environment and the caller's idempotency key; a changed body is a
conflict, not a second admission. The authority is immutable for that admission:

| Admission | Who may reserve, settle, refund and invoice it |
| --- | --- |
| Existing Oxy grant/reservation | Oxy, using its existing immutable price snapshot |
| Kaana-owned admission after cutover | Kaana, using its own immutable price snapshot |

The same operation must never fall back to the other ledger after timeout,
unknown outcome or restart. Kaana's settlement outbox sends only Oxy-owned
grants to Oxy; Kaana-owned settlements stay in Kaana. Oxy keeps accepting
valid late settlements and expiring old holds while that population drains.
An authority discriminator belongs in the durable admission/contract, not an
environment switch evaluated afresh on every retry. A body, receipt or
authority conflict is refused and reconciled rather than charged again.

For retry keys already admitted by Oxy, cutover must consult or migrate the
old idempotency binding before creating a Kaana admission. A new transport
alone cannot provide that fence. Before enabling a population, test retries
straddling the cutover, two concurrent instances, lost responses, expiry and
late settlement.

## Application cutover barrier and legacy retry manifest

Migration 0255 introduced empty, permanent workload fences. Migration 0256 adds
application/environment fences without activating any population or changing an
existing fence. The application-wide scope matches the existing daily capacity
counter: changing credential lane or payer must not create a second daily budget.
A reviewed operator command verifies the current application owner and a live
workload binding, then fences **every** admission for that application/environment.
Other applications and environments remain independent. This does not revoke
OAuth access or credentials; callers outside Kaana's explicit enrollment are
refused, never silently sent back to Oxy.

The database trigger protects rolling older API images. All admissions and fence
activation share an application/environment transaction advisory lock. Migration
0256 briefly locks metered-usage writers before replacing the old owner-specific
lock function, draining transactions that already acquired its old key. It does
no backfill while holding that lock. Either an old admission commits before the
fence and must drain, or its insert fails before a hold/provider call. Upgraded
writers return retryable `service_unavailable` with `reason: authority-migrating`.
Existing workload-only fences keep their original meaning but cannot authorize
a version-2 application export. Old settlements remain allowed; fences cannot
be updated or deleted.

The reviewed CLI is `packages/api/src/scripts/inference-authority-cutover.ts`.
It requires explicit `--application`, `--owner`, `--environment` and one action:
`--activate --confirm-application=<same ID>`, or `--export --output=<new file>`.
There is no automatic enrollment or rollback command. Before activation, review
all legitimate live callers, the exact enrolled workload roster, both fleets'
ready code, settlement drain and the Kaana importer. The initial enrollment is
the API workload only; a second live integration binding is not authority to
infer, and historical service credentials are not automatically enrolled. Activation is a deliberate availability boundary until verified
manifest import and native enrollment complete.

Export is a read-only repeatable-read transaction and refuses any application/environment
`admitted` usage row, `issued` grant or `held` reservation, even past its expiry.
It retains all historical non-refused admission keys and reservation keys across
all owners and credential types in that application/environment.
Canonical identity is credential plus key kind and exact key; both caller-key
and request-ID aliases are exported. Duplicate ownership conflicts or unknown
namespaces stop export instead of silently dropping a retry binding.

The version-2 manifest contains authority `oxy`, fence ID and timestamps, exact
population (`credentialKind: application`), zero unresolved counts and sorted entries.
It also includes `dailyUsage: {scope: application_environment, utcDay, admitted,
maxRequestsPerUtcDay}`. `exportedAt` and `utcDay` come from the same database
transaction clock. `admitted` uses the unchanged admission counter: all non-refused
metered admissions created since UTC midnight, including failed, cancelled and
realtime requests, without filtering owner, credential or relationship. The
positive effective daily limit comes from the unique reviewed service relationship
and its Console override; unknown or relationship-only budgets refuse export.
The importer verifies the limit against reviewed policy, requires a current-day
snapshot for activation, and preserves prior native consumption when importing
or refreshing the legacy component. It never resets the day or derives it from
idempotency keys. These fields participate in the immutable manifest hash.
 `population.credentialIds`
is the sorted live verified workload roster, including handles without history.
Native policy must explicitly enroll a reviewed subset of that roster; session,
machine and secret-backed service credentials never inherit it through an app ID.
New handles require a new reviewed immutable policy version. Historical tombstones
remain exported even for retired handles without authorizing those handles. Each entry carries
`credentialId`, `keyKind`, `key`, `legacyAdmissionId`, `requestId`,
`bodyDigest: null`, `digestDomain: unknown`. Oxy edge records lack request-body
hashes; old grant authorization hashes do not establish equivalence to native
public request bytes. These unknown-digest tombstones must always refuse native
execution, regardless of the retry body. No invented digest is permitted.

`sha256` hashes the manifest without that field using the existing
`@oxy.so/protocol` canonical JSON serializer (recursively sorted object keys,
standard JSON string escaping, no whitespace). Entries sort lexically by the
canonical JSON tuple `[credentialId,keyKind,key]`; timestamps are exact UTC ISO
strings. The CLI exclusively creates a mode-0600 artifact and prints only the
entry count. Keys, tokens, prompts and database errors are not logged. Kaana must
verify population, epoch, checksum and complete import before native activation;
a timeout or stale fleet must fail closed, never re-admit through Oxy.

## Balances and history

Oxy's `account_balances` is keyed by account and currency; applications can
share their nearest active ancestor's billing profile. Migrating one app
while copying that shared balance would make the same money spendable twice.
Transfer at the funded-account/currency boundary, or explicitly partition
funds with journal entries. A read-only census must establish the actual
population before choosing between those approaches.

The narrow safe sequence is to stop new admissions for that funded population,
drain or explicitly transfer outstanding holds, reconcile all purchased,
promotional, reserved and invoiced buckets against their append-only journals,
then record uniquely keyed transfer entries and activate Kaana. Preserve
promotional expiry/source restrictions, debts, discounts, spending limits,
immutable prices and payment references. Do not erase or rewrite Oxy's
receipts and issued invoices. Keep historical reads accessible under their
original authority; a newly issued invoice must not include a receipt already
linked to an old invoice.

For the transport transition before ledger migration, Kaana's receipt API
already delegates to Oxy's existing receipt readers. Historical Oxy-edge
receipts therefore do not need a new source column merely because the HTTP
host changes. They still require the original application entitlement;
idempotency lookup also binds credential, owner, environment and attribution.
The current Gemies backend retains the former Alia application identity, so
this transport change does not require a historical identity migration. A
future application-identity change would require its own access migration.

## First-party traffic and payment readiness

The reviewed Gemies source (`packages/server/src/identity.ts` at `bffc08ab`)
sets `GEMIES_APPLICATION_ID` to the former Alia application ID. The November 13
read-only production probe confirmed the same active, unexpired internal
application binding on the backend workload. The production policy file's hash
matched reviewed Oxy `f0ae4196`: that identity currently receives `alia-kaana`
internal metering, including the 2,048-output-token and $0.05 request bounds.
The probe performed no inference and no financial writes, and its task stopped
successfully.

The separate newly registered Gemies application is not this backend's
principal and must not automatically inherit its policy. An earlier source
review conflated the registration with the backend constant; source and live
binding are consistent. Kaana's first-party enrollment must bind the verified
current identity and reviewed limits. No endpoint migration authorizes changing
internal traffic to paid traffic, removing economic bounds or reviving the superseded
Oxy [#2256](https://github.com/OxyHQ/oxy/pull/2256) ceiling proposal, now closed
unmerged and archived as `archive/fix/alia-planning-output-policy-20261113`.

Code distinguishes two payment integrations:

- Inference top-ups still call the actual Stripe SDK through
  `stripeAccountBilling.service.ts` → `getBillingStripe()` → `getStripe()`.
  This source path is not proof that production credentials are configured.
- Oxy One personal plans use native Peable and a separately reviewed billing
  workload. `peableBillingWorkload.service.ts` refuses ambient authority and
  validates the returned merchant, application and environment. That merchant
  is not automatically Kaana's seller.

The November 13 read-only Peable lookup found zero production merchants for
Kaana's exact application. The task stopped successfully with no writes. Seller
configuration is therefore still required before commercial invoicing; do not borrow Oxy One's
merchant or create live prices, balances, subscriptions or charges as part of
an implementation test. Exact decimals, transactional holds, append-only
journals and idempotent processor reconciliation remain mandatory.

## Remaining inputs, narrower than the former open-question list

The owner has already decided the responsible product. Do not ask that again.
The following require evidence or a concrete decision before their respective
live cutover, rather than blocking all implementation:

1. **First-party policy:** the current backend binding is verified. Bind Kaana
   enrollment to that identity and retain the reviewed treatment and limits;
   do not infer enrollment from a product name or newly registered app.
2. **Seller configuration:** the production Kaana Peable merchant is absent.
   The owner must identify the legal seller and approved fiscal configuration
   before merchant creation. Do not invent invoice or tax settings.
3. **Existing funded population:** read-only totals of nonzero balances,
   outstanding holds/debts, shared funding accounts and processor references
   determine the transfer plan. Approval is for that concrete transfer, not
   a generic request to "migrate billing". No production financial mutation
   is authorized by this ADR's design draft.

The old financial path may be retired only after successful Kaana-owned
admission/receipt/invoice acceptance, journal reconciliation, old-outbox drain
and an explicit historical-read solution. Until then, report transport,
identity, accounting and invoice readiness separately.
