# Canonical AI request routing

This document is the authority for choosing between Kaana and Alia. It is an
architecture contract, not a production-status assertion: deployment state must
be verified with the live Oxy and Kaana rollout gates.

## Responsibilities

| System | Responsibility |
|---|---|
| **Oxy** | authenticates the caller; resolves account, application and delegated user; checks scopes and policy; reserves spend; signs the request; settles the receipt |
| **Kaana** | executes the signed request; selects only among authorized routes; adapts provider protocols; streams and cancels; measures technical usage and provider health |
| **Alia** | runs assistants and agents; owns conversations, memory, tools, approvals and orchestration; invokes models through Oxy and Kaana |

The canonical signed data-plane origin is
[`https://kaana.ai`](https://kaana.ai). No Oxy subdomain or old inference-service
name is a compatibility origin. The Oxy edge is still the customer authority:
Kaana does not issue customer keys, authorize accounts or own the billing
ledger.

Historical provider adapters and provider aliases that ran under Alia, plus the
former inference service identity, are Kaana. **The Alia product itself remains
Alia** because agent behavior is not provider execution.

## Choose the path by product behavior

```text
bounded one-shot operation -> product -> Oxy inference edge -> Kaana
stateful agent operation   -> product -> Alia -> Oxy inference edge -> Kaana
```

A one-shot operation is owned by the product and has no assistant state: for
example translate, classify, summarize, rewrite or draft a smart reply. An
agent operation needs conversation history, memory, tools, approvals or a bot
identity. The fact that both eventually invoke a model does not make them the
same integration.

| Product surface | Required route |
|---|---|
| Mention assistant/chat | Mention -> Alia -> Oxy -> Kaana |
| Mention translation, classification and moderation helpers | Mention -> Oxy -> Kaana |
| Inbox embedded assistant/chat | Inbox -> Alia -> Oxy -> Kaana |
| Inbox summary, rewrite and smart reply | Inbox -> Oxy -> Kaana |
| OxyOS assistant | OxyOS -> Alia -> Oxy -> Kaana |
| Homiio Sindi | Homiio -> Sindi as an Alia agent/bot -> Oxy -> Kaana |
| Clarity assistant | Clarity as an Alia agent/bot -> Oxy -> Kaana |

Sindi and Clarity need Alia agent identities and bot-account delegation. They
do not get provider credentials or private provider adapters. Provisioning,
ownership and delegated-user attribution must be verified in Oxy and Alia before
either integration is described as deployed.

## Provider-key custody

Upstream provider plaintext has one durable destination: Kaana's PostgreSQL
`provider_credentials` table, encrypted by KMS with context binding it to
`provider + keyId`. It never belongs in an app, Alia, Oxy or Kaana environment
variable; a GitHub secret; a task definition; a model inventory; argv; or a
tracked file. `DATABASE_URL` is a database connection credential, not a provider
key.

Legacy SSM values are migration inputs, not supported steady state. The
allow-listed `kaana-credentials import-ssm` command reads a `SecureString`
directly through the AWS SDK, emits no value and writes KMS ciphertext to
PostgreSQL. The historical Cerebras value follows this path. Remove the legacy
parameter, old deployment reference and old service only after non-secret row
metadata, authenticated discovery and a real signed Kaana request all pass.

BYOK customer secrets remain an Oxy control-plane concern governed by ADR 0013;
they are not the platform's own upstream provider-key pool.

## Provider and model discovery

The unlicensed `itsfree.ai` checkout is a discovery lead only. No code, prose or
catalogue data is copied from it. Each provider origin, protocol, model identity
and account-visible deployment is re-derived from provider-owned documentation
or an authenticated provider API and must pass Kaana's onboarding gates.

## PostgreSQL-only invariant

Oxy, Kaana and Alia production state use PostgreSQL. New work must not add
MongoDB, Mongoose, `MONGO_*` or `MONGODB_*` configuration, a localhost Mongo
fallback or a parallel Mongo read/write path. A remaining Mongo reference in an
older app is migration debt to remove, not an approved architecture and not a
reason to copy Mongo into another component.

## A cutover is complete only when measured

A merge does not prove production. Before removing the old inference path,
verify all of the following against live state:

1. the Oxy service has the complete Kaana signing configuration and no old
   inference base URL or provider-key secret;
2. Kaana serving tasks are running and healthy behind `https://kaana.ai`;
3. a real Oxy-signed request streams successfully, cancellation reaches the
   provider, and settlement records the same `requestId` exactly once;
4. a disallowed route/region and an invalid signature fail closed;
5. provider credentials load from PostgreSQL/KMS and no provider key appears in
   any live task definition;
6. Sindi and Clarity bot/agent provisioning is verified before those product
   paths are enabled;
7. observability, rate limiting and rollback gates pass through the soak window.

Until those checks pass, documentation may describe the target architecture and
the implementation, but must not call the production cutover complete.
