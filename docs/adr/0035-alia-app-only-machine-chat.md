# ADR 0035 — Alia app-only machine chat from Oxy Console

Status: accepted after source review; coordinated backend, SDK and Alia release required.
Date: 2026-10-04. Related: #1571, #972; the broader #873/#874 service-access model remains separate.

Console is the sole issuer of product API credentials. A machine credential is an application principal, not its owner's user session and not an internal service. Alia must not pay for a third-party application's inference or expose its owner's product context.

An explicitly granted `alia:chat` capability targets only Alia's stable registered application `6a2f851751b784a86fd0e934`. Admission additionally requires `inference:invoke`. Oxy resolves the existing `oxy_sk_*` machine credential on every request: secret, type, status, expiry, environment, application status and credential/application scope intersection stay canonical. Empty scope arrays convey no authority. Neither capability adds grants to existing rows. Migration 0143 widens the three scope CHECK vocabularies only.

Only Alia's authenticated, trusted resource-server identity can call `POST /internal/alia/machine-credentials/introspect`. The reply contains a strict machine principal, fixed recipient and two effective scopes. It contains no user subject, service tier, token or delegated grants. Receiver service authentication does not promote the caller to a service principal.

`OxyServer.apps.introspectAliaMachineCredential` and `createOxyAliaMachineCredentialAuth` live exclusively in `@oxy.so/core/server`. The middleware keeps the caller bearer in a request-scoped WeakMap and attaches separate `machineCredential` metadata; it never fills `req.user`, `req.serviceApp` or SDK session state. Introspection is uncached and unretried. Unknown/revoked/ungranted credentials share a neutral refusal; transport failures are closed and do not echo credential-bearing errors.

Alia opts in only on POST `/alia/chat` and `/v1/chat/completions`, both using the shared product handler. The first lane is app-only chat: closed generation options and messages, no personal agents, memory, conversations, local runtimes, connectors, tools, requester assertions or `X-Oxy-User-Id`. The verified caller bearer reaches only the canonical Oxy inference client. Oxy revalidates it and derives the caller application's payer. There is no fallback to Alia's own credential. Human and delegated service lanes retain their existing contracts.

The API migration/endpoint and the new core server exports must ship before Alia adopts the reviewed registry package. No unpublished package reference, version bump, default scope grant or production mutation belongs to this candidate. This specific recipient/capability does not complete the generic service-recipient and grant model in #874.
