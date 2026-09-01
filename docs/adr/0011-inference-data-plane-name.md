# ADR 0011 — `Kaana` is the canonical inference data-plane name

- Status: accepted
- Original decision: 2026-08-15
- Clean-cut rename: 2026-09-01
- Issue: #972

## Context

The inference data plane was originally introduced under the working name
`Relay`. That name was generic, collided with established networking and
federation terminology, and left the same product represented by different
identities across repositories, runtime resources, environment variables,
headers, and model aliases.

Oxy also contains unrelated uses of the common noun “relay”, including SMTP,
device transfer, OAuth message forwarding, atproto, and TNP infrastructure.
Those uses describe their actual protocols and are not part of this decision.

## Decision

The inference data plane's canonical and customer-facing name is **Kaana**.
The former `Relay` identity is retired with a clean cut:

- the repository is `OxyHQ/Kaana`;
- binaries, packages, services, logs, metrics, IAM resources, and deployment
  resources use `kaana`;
- data-plane configuration uses `KAANA_*` variables;
- authenticated internal requests use `X-Oxy-Kaana-*` headers and the
  `oxy-kaana-envelope:v1` signing domain;
- the signed data-plane endpoint is `https://kaana.ai`;
- product model aliases owned by this routing layer use the `kaana-*` prefix.

There are no compatibility aliases for the old product name. A partially
migrated deployment must fail closed instead of silently accepting the former
headers, variables, identifiers, or signing domain.

This decision does not rename genuine protocol relays. Identifiers such as
`SMTP_RELAY_HOST`, TNP relay services, device-transfer relays, and ordinary verbs
that describe forwarding retain their established meaning.

The public API at `api.kaana.ai` remains an Oxy control-plane edge: it
authenticates customers, resolves models, reserves spend, and signs an authorized
request for Kaana. `https://kaana.ai` is the inference data plane and accepts only
authorized envelopes. Contract fields remain role-named, such as
`resolvedModelReference`, `servingProvider`, and `deploymentId`.

## Consequences

- Search results for `Relay` in inference code indicate incomplete migration;
  search results in SMTP, federation, device transfer, or TNP code do not.
- Operators must change the edge and data plane atomically because the former
  signing domain and headers are deliberately rejected.
- Provider credentials belong to Kaana's encrypted database-backed credential
  store. They are not edge configuration and must never be passed through
  environment variables.
- Customer-facing docs and model selectors consistently describe Kaana, while
  wire contracts continue to describe responsibilities rather than brands.

## Alternatives rejected

**Keep `Relay` as an internal compatibility name.** Rejected because it would
preserve the split identity indefinitely in deployment, IAM, observability, and
incident response.

**Rename every occurrence of the word relay.** Rejected because protocol relays
are separate components. Renaming them would make those modules less accurate
and would conflate an identity migration with unrelated behavior changes.
