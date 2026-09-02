# Changelog: `@oxyhq/contracts`

## 0.36.0

### Added

- Canonical contracts for actors, resources, delegation grants,
  automations, capability tickets, app capability catalogs and correlated
  audit events.
- A typed email-agent context that carries the effective mailbox and account
  instead of relying on prompt conventions.

## 0.29.0

### `safeErrorTextSchema`: redacting against the old pattern could make a leak worse

**Read this if you produce inference error text.** The credential pattern was
bearer-shaped — it matched markers (`authorization:`, `api_key=`, `sk-…`) and
nothing about the value beside them. An upstream echoing a request header sends
`{x-api-key: <the key>}`; the pattern matched `api-key`, so a producer redacting
the SPAN it matched emitted `{x-[redacted] <the key>}`, which no longer matched
and was therefore **accepted**. The unredacted string was refused and the
redacted one was not, and both carried the key. Measured by the second outside
implementation of this contract (OxyHQ/Relay#3), not theorised.

The refinement now checks four independent signals, so removing one does not
clear a string: a credential-bearing name (the whole `x-…`/`…-api-key` family,
not two literal spellings) assigned a value long enough to be a credential; a
bearer token; issued token grammars that are credentials wherever they appear
(`sk-…`, `sk_live_…`, JWTs, `AKIA…`, `ghp_…`, `AIza…`); and a redaction
placeholder standing next to a value that survived it.

**What this refuses that it did not:** a header-family marker with a live value,
an issued token with no marker in front of it, and a redaction that left the
value behind.

**What it now accepts that it did not:** a marker whose value has been replaced —
`Authorization: [redacted]`, `api_key=***`. That is deliberate. Refusing a
correct redaction is what made stripping the marker the only way to satisfy the
old pattern, which is the defect above.

**It is a last-resort refusal and not protection, and the doc comment now says
so.** A pattern reading the output cannot be the primary control; redacting the
known secret VALUE, at the point where the producer still holds the bytes it
sent, is. Do not redact by replacing the span this pattern matches, and do not
read acceptance here as evidence a string is clean. This package deliberately
ships no redaction helper: one keyed on these patterns would rebuild the same
defect a layer up.

### Added

- **`provider_billing_refused`** — an upstream declining to bill OXY (several
  answer `402`). Non-retryable, like `provider_credential_invalid`, and separate
  from `quota_exceeded`, which is right about retryability and points the
  customer at their own balance — an account that is not the one at fault.
- **`refusal`** as an `inferenceFinishReasonSchema` member, distinct from
  `content_filter`. The model declining to answer and an upstream filter removing
  an answer are separate events, and the delta channels already carried the
  distinction (`channel: 'refusal'`).

### Changed

- `INFERENCE_CONTRACT_VERSION` is `1.1.0`. The version rule now states that a
  closed enum gaining a member and a refinement changing which bytes parse are
  both MINOR: each lets a producer on the newer set emit something the older set
  refuses, with no per-message `schemaVersion` difference to explain it.

## 0.25.0

### Licence: AGPL-3.0-only becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`@oxyhq/contracts` is now Apache-2.0. The code, the API surface and the behaviour are
unchanged in this release. It exists to carry the licence change.

This is a widening. Every right the AGPL granted you, Apache-2.0 grants too,
and Apache-2.0 additionally drops the network copyleft and adds an express
patent grant. Nobody has to do anything, and no existing use of this package
becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `0.24.0` stays AGPL-3.0-only for anyone who already has it. A licence
change binds future versions only.

`@oxyhq/contracts` is below 1.0.0, where semver puts the breaking position in the minor
and `^0.24.0` does not accept `0.25.0`. Bumping the minor is therefore the
same signal a major bump gives a 1.x package: no consumer picks this up
without editing their manifest, which is the whole point.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.
