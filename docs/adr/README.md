# Architecture decision records

Each file records one decision, the context that forced it, the alternatives that
were rejected and why, and what the decision costs. An ADR is the answer to "why
is it like this"; it is not a guide to how the code works today — that lives in
`docs/`, and the history lives in git.

An ADR is updated in place only to record its own closure (a deferred decision
becoming a decided one). Otherwise it is superseded by a later ADR that names it.

## Index

| ADR | Issue | Decision |
|---|---|---|
| [0001](0001-multi-principal-device-model.md) | #937 | A device holds principals, and principals hold account contexts — `device_principals` + `device_account_contexts` replace the flat `device_session_accounts` projection. |
| [0002](0002-global-account-context.md) | #937 | One globally active context per device, activated through one endpoint. |
| [0003](0003-browser-device-session-hub.md) | #937 | `auth.oxy.so` becomes the browser's first-party DeviceSession hub, holding an opaque `__Host-oxy-device` handle; relying-party origins stay zero-cookie. |
| [0004](0004-single-oxy-runtime-provider.md) | #937 | One headless `OxyRuntime` owns session truth behind one public `OxyProvider`; React is an adapter over it. |
| [0005](0005-oxy-is-the-single-control-plane.md) | #972 | Oxy is the single control plane for accounts, applications, credentials, permissions, customer billing and Console; the inference data plane owns no customer. |
| [0006](0006-oxy-relay-boundary.md) | #972 | The data plane executes inference and stores only immutable references to Oxy ids; the responsibility matrix gives every domain one source of truth. |
| [0007](0007-canonical-request-attribution.md) | #972 | Every inference request carries `accountId`, `applicationId`, `credentialId` and `requestId`; a delegated `userId` is attribution and never the billing identity. |
| [0008](0008-catalogue-concept-separation.md) | #972 | Publisher, model, immutable model revision, inference provider, deployment and routing profile are six distinct concepts; `alia-lite`/`alia-v1`/`alia-v1-pro`/`alia-v1-pro-max` are retired as model identities. |
| [0009](0009-usage-reservation-and-settlement.md) | #972 | Spend is reserved before execution, settled against an exact receipt with a price-version snapshot, and reversed by appending; amounts are exact, never floating point. |
| [0010](0010-public-api-compatibility.md) | #972 | `api.oxy.so/v1` is the Oxy public inference edge, with `POST /v1/responses` preferred beside an OpenAI-compatible surface, one versioned internal envelope, and a producer-asserted retryability contract. |
| [0011](0011-inference-data-plane-name.md) | #972 | The inference data plane's production name is deferred pending naming/trademark review; `Relay` is a working name and ships in no published artifact. |
| [0012](0012-service-token-signing-key-model.md) | #972, #987 | Service tokens move to asymmetric (Ed25519) signing verified against a published JWKS; the shared HMAC secret is retired, because a symmetric verification key is also a mint key and after ADR 0007 that forges spend attribution. |

## Related

- [`../architecture/inference-responsibility-matrix.md`](../architecture/inference-responsibility-matrix.md)
  — the committed per-table/event/API ownership record governed by ADRs 0005–0011.
