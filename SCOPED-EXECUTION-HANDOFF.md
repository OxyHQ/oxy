# Scoped execution contracts foundation

Branch `feat/jev-scoped-oxy-20261002`, integrated base
`a2d55ad4a63fec0461b9013a6c3eaf7e2bde6cc2` (security and promo-only ledger).
The implementation is dormant. No source manifest is enabled; no provider
requests, credentials, grants, production changes or public API permit exist.

## Exact wire authority

`ScopedExecutionAudience` has stable `permitId` independent of the actual
edge-allocated request ID; no operationId alias. Strict fields:
idempotencyKey, fixtureSha256, expiresAt,
principal {accountId, applicationId, credentialId, environment},
policy {routingPolicyId, policyVersion}, deploymentId, provider, keyId,
modelReference, upstreamModelId, priceVersionId, providerRateCardVersionId,
providerSourceVersion, maxCostUsd.

`ScopedExecution` adds requestId (must equal normal attribution), snapshotId,
catalogueEvidenceHash. The latter is Oxy's hash of actual normally qualified
candidate evidence, not a fabricated catalogue or protocol version.

`scopedInferenceRequestSchema` declares envelope v3 and requires the restriction.
It binds actual attribution, idempotency, policy, one exact platform deployment
and pinned model, and retains all ordinary decisions request refinements.
`inferenceRequestSchema` remains v2; it recognizes and refuses scopedExecution.
Old v2 receivers reject v3 before interpreting its fields. No downgrade exists.

The audience is optional on actual `modelDeploymentSchema` only, never on an
aggregated model that can have both scoped and ordinary deployments.

## Explicit negotiation

Global `INFERENCE_CONTRACT_VERSION` stays 3.5.0. Extension constant
`SCOPED_EXECUTION_CONTRACT_VERSION` is 3.6.0, scoped-only envelope constant is 3.
The package is 4.8.0. These versions are not catalogue identities.

Signed exact deployment query body adds
`scopedExecutionContractVersion:'3.6.0'`; response must positively echo it.
Negotiated descriptors carry actual per-deployment audience/key/upstream/card/
source identities. Legacy queries, metadata and hashes remain unchanged.

Normal full publication uses the root-authorized read-only
`POST /internal/v1/models/query` with body-signed version 3.6 and response echo.
Legacy GET models is unchanged. Join actual audience via exact descriptor IDs;
scoped imports cannot receive generic automatic commercial-rights approval.

## Canonical fixture bytes and parity

Fixture hash covers the exact canonical WHOLE input JSON bytes actually sent
inside the signed envelope. The scoped serializer must canonicalize those bytes;
Kaana extracts raw signed input rather than reserializing decoded Go values.
All ordinary signing-domain and signature bytes remain unchanged.

Frozen cross-language fixture:
`packages/contracts/src/__tests__/scopedExecution.golden.json`.
It includes actual decisions input with astral Unicode, literal backslash-u,
U+FFFD, HTML characters and U+2028/U+2029, plus explicit UTF16 key ordering
(astral U+10000 before BMP U+E000). It freezes UTF8 bytes and SHA256, and tests
staging and UTF16-boundary limits. Zod lengths count UTF16 units, not UTF8 bytes.

## Validation and integration limits

Full contracts suite: 50 suites / 891 tests PASS. ESM, CJS and declaration
builds PASS; formatter/lint on new files PASS; compatibility census includes
the separate scoped v3 shape while legacy v2/3.5 fixtures remain intact.
The locally built 4.8.0 artifact is `packages/contracts/oxy.so-contracts-4.8.0.tgz`.

The companion API branch owns authenticated private source manifest, exact
eligibility/expiry/hash/price checks, normal publication/qualification, promo-only
reservation and exact held settlement. The Kaana branch owns negotiated
publication, raw Unicode/fixture checks and durable permit burn before transport.
Those layers require separate review; these contracts alone authorize nothing.
