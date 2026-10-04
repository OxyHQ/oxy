# Private Auto classifier contract

Implementation proposal for Oxy#1572 at base `4c29c62d0fb40a018a3434ca08fdbdcfd5e37d07`.
This is repeatable private classification of variable task text. The source
getter is absent; ordinary decisions remain unavailable. No provider, privacy,
ZDR, model-rights or quality approval is supplied by these synthetic fixtures.

## Authority and compatibility

Negotiate `privateAutoExecutionContractVersion: 3.7.0` independently of ordinary
3.5/v2 and fixed-input commissioning 3.6/v3. Private Auto uses envelope v4 and
its own `privateAutoExecution` field. Neither a v2/v3 receiver nor a server without
the new negotiated extension may serve it. No current negotiation is activated.

Both Oxy and Kaana must hold the same reviewed source approval. It names one
production service principal (owner account, application and existing workload
credential), pinned routing/economic policy and relationship, exact deployment,
revision, provider, key, complete region set, price version, provider rate card
and source observation. Explicit private-use rights, legal, privacy and ZDR
evidence have their own expiry. `commercialUseAllowed` remains the actual fact;
an internal approval never changes it to true or grants public resale.

The source approval contains no input, fixed fixture hash or idempotency key.
Only the child input's state varies; instructions and the single typed Choice
question over instant/medium/high/xhigh are exact. State is data, never authority.
There are no tools, stream, effort or generation parameters on this child.
Source expiry must remain within the review evidence's expiry; every admission
and dispatch rereads authority and current route/price/privacy facts.

## Parent, child and execution

1. Oxy qualifies and quotes the parent at its deterministic floor, then claims
   its durable metered operation before exposing any text. An existing key,
   failed scope/policy/privacy/price/capability or an unavailable higher route
   cannot trigger a classifier.
2. Pass the actual parent metered UUID to the private child adapter. The child
   request, idempotency key and Kaana operation ID are all
   `oxy-private-auto:<parentMeteredUsageId>`. They do not contain a review
   revision, random attempt or input hash. Renewing an approval never allows a
   second execution for that parent.
3. Validate the parent row: it exists, matches request and principal, is an
   unexpired internal-metered admission under the exact policy/relationship,
   has no parent itself, no delegated user, and no final generation authorization. Child quota
   and insertion run under the existing application/environment advisory lock,
   with the parent locked in the same transaction. Real database time is rechecked after both lock waits, including the original child deadline; transaction-start `now()` cannot renew a parent. Parent and child consume
   separate slots in the existing concurrency/day limits. The child's stable
   request ID stays unique even if a pre-dispatch refusal releases its ordinary
   partial idempotency key.
4. Bind the exact whole normalized child input hash to that operation and the
   source approval hash. These hashes exist only in transient signed request
   bytes; no private input/hash is added to a database, public proof or log.
   Sign one exact attested deployment under the unchanged policy, identity,
   capability, price and privacy gates. No fallback or substitute inherits it.
5. Kaana validates the negotiated envelope, source approval, signed principal,
   parent/operation identity and exact raw signed input hash. It rechecks the
   actual provider credential/route and takes a permanent claim keyed on the
   operation ID before one provider POST. The lease is bounded independently
   of source expiry; neither expiry nor a different review/input releases the
   consumed primary key. No provider attempt retry for this child.
6. A real typed provider reply may raise the deterministic floor only to an
   available level. Confidence does not route. Oxy requalifies the parent
   after classification. Cancellation aborts the child; timeout, malformed or
   unavailable classification keeps the existing deterministic result. Late
   replies cannot change a dispatched parent.

Limits remain 1,000 ms, 8,192 UTF-8 state bytes and 8,192 whole controlled input
bytes, at most USD 0.001 per quote, further narrowed by policy. Oversized state
falls back without truncation. The 29 KB real Hello/21-tool builder is outside
this classifier budget and legitimately keeps deterministic Auto. That does not
prevent bounded variable text requests from using the classifier. Quotes and
upstream measured costs remain separate; unknown provider cost is not zero.

## Recovery and activation

Admission requires an active parent. Read-only recovery instead checks current
own `inference:usage:read` authority and the retained parent/child lineage; it
can retrieve the original child's metering after settlement/source expiry.
It never starts another classifier or returns retained private input/output.

The initial source change remains inactive. Delivery requires Oxy and Kaana
contracts, catalogue/signed-descriptor projection, SDK compatibility where
exported, SQL qualification and both-side image checks before negotiation. A
later source activation requires actual canary evidence and explicit review of
the precise repeated private use. It does not approve the general catalogue,
ordinary decisions or commercial resale. Release versions belong to the root
release owner; the implementation changes no package version.

## Required qualification

- Two different private states produce different exact hashes while keeping one
  operation identity per parent; another parent has its own unique operation.
- Unknown/foreign/expired/settled/nested/already-dispatched parents fail before
  a child claim or provider call. Concurrent child claims and independent quota
  limits are checked with actual PostgreSQL, not a mock counter.
- Changed or expired review, policy, principal, economics, region, key, route,
  input, card, observation or price refuses; no public request field activates
  private authority. Actual internal rights can be true while commercial rights
  stay false.
- Known-child recovery after settlement/expiry uses current own read authority
  and emits zero provider POSTs. Lost acknowledgements never repeat mutations.
- Provider cancellation/timeout/late reply and parent requalification keep
  independent settlement and deterministic fallback semantics.
- Legacy 3.5/v2, one-fixture 3.6/v3 and ordinary public denial remain qualified.

The first implementation block supplies the schema, inactive getter, pure
binding/recovery identity checks and atomic parent/child metering barrier. The
end-to-end adapter/envelope/catalogue/Kaana wiring is a remaining implementation
step, not an activation or completed production claim.

## Inactive transport integration

The signed descriptor carries `privateAutoSourceApproval` only with its independent
`privateAutoExecutionContractVersion: 3.7.0` acknowledgement. Exact route, provider
credential identity, model, regions and rate/source versions must match that
approval; commissioning 3.6 cannot stand in for it. The absent source getter
leaves production catalogue negotiation unchanged. Ordinary publication excludes
both private metadata classes. Schema 4 uses the canonical actual input bytes
and verifies their hash before signing one decisions request; it has no stream
path. The original absolute deadline covers serialization, send and response.

Catalogue persistence, private route selection and the parent/child classifier
adapter remain subsequent integration steps; the transport slice alone does
not make this a completed or activated Auto feature.
