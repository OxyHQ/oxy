# Changelog: `@oxy.so/api`

## Unreleased

### Changed (Inbox mail integrity)

- **Breaking for clients sending a row id:** `POST /email/messages` and
  `POST /email/drafts` answer 400 unless `inReplyTo` and every `references`
  entry is an RFC 5322 Message-ID (`<id@host>`). `sendMessageForUser` enforces
  the same for Alia tickets and MCP. When the sender holds the parent, the
  server derives `References` from the parent's chain.
- `Idempotency-Key` sends take a durable claim (an `email_outbox` row) before
  the relay is contacted, so a retry of the same key on any task returns the
  first outcome instead of sending again. `queued: true` now also covers "the
  first attempt is still in flight".
- Inbound mail from all three paths goes through `parseInboundMime`: the AMP
  (`text/x-amp-html`) and Apple Watch alternative bodies are no longer stored as
  an attachment named "attachment".
- Every user message carries `X-Oxy-Sent-Id`; the relay-assigned Message-ID
  (SES) is kept as `messages.relay_message_id` and threads replies; a user's own
  message coming back is linked by `messages.sent_copy_of` and shown once in its
  conversation (migration 0121, pre).
- One-off operations: `src/scripts/purge-alternative-body-attachments.ts` and
  `src/scripts/repair-reply-row-id-threading.ts`, each `--dry-run` / `--apply`.

### Added

- Instagram Graph fallback: `*@instagram.com` handles whose kilogram bridge
  resolution fails (429, timeout, refusal) resolve through Meta Graph API
  Business Discovery as protocol `instagram-graph`, actor
  `instagram-graph:<igUserId>`; `POST /federation/identities/resolve` accepts
  `protocol: 'instagram-graph'` for Instagram handles (400 otherwise). Inert
  unless `INSTAGRAM_GRAPH_FALLBACK_ENABLED=true`, `META_GRAPH_ACCESS_TOKEN` and
  `META_IG_BUSINESS_ACCOUNT_ID` are set (`META_GRAPH_API_VERSION` defaults to
  `v23.0`). See `docs/identity/external-identities.md`.

### Changed

- URL slash trimming (`nodeRegistry`, `mcpOAuth`, `config/cdn`) no longer uses
  `/\/+$/`, which backtracks polynomially on a long run of slashes
  (`utils/slashes.ts`).

### Removed

- **Breaking:** the last staff hands on people's standing —
  `POST /reputation/moderation/incidents/:incidentId/reconcile`,
  `GET /reputation/moderation/incidents/:incidentId/effects` and
  `POST /civic/personhood/:userId/recompute`, and the staff view of another
  person's `GET /reputation/moderation/standing/:userId` (now the subject's
  alone). Personhood already recomputes on every vouch, attestation and audit
  outcome. Moderation needs no reconciliation at all: applying a newer
  revision reverses the one it supersedes in the same transaction, and an
  appeal reverses a consequence (strike, compensating entry, effect) in one
  transaction, so no half-applied state can exist to repair.
- **Breaking:** reputation staff routes — `POST /reputation/rules`,
  `POST /reputation/transactions/:id/reverse`, `POST /reputation/transactions/:id/void`,
  `POST /reputation/:userId/recalculate`, `GET /reputation/disputes`,
  `POST /reputation/disputes/:id/resolve` — and disputes (`POST /reputation/disputes`,
  `GET /reputation/:userId/disputes`). Staff get no special view of a balance,
  a ledger or influence weights. `POST /reputation/award` takes a service token only.
- Reputation rules are code (`src/services/reputationRules.ts`, versioned);
  `GET /reputation/rules` returns `{ version, rules }`. Migration
  `0119_reputation_rules_in_code` (post-deploy) drops `reputation_rules` and
  `reputation_disputes`.
- `GET /auth/lookup/:username`, `GET /accounts/:id/children`,
  `GET /users/me/data` (use `GET /users/me/export`) and the
  `/accounts/service/channels*` provisioning routes with their
  `accounts:provision` scope.

### Fixed

- A reversed confirmed report no longer counts toward report accuracy through
  its compensating entry.

## 2.0.0

### Licence: this package moves to the Breathe License 1.0

**Breaking, and a genuine narrowing rather than paperwork.** `@oxy.so/api` is now
licensed under the Breathe License 1.0, identifier `LicenseRef-Breathe-1.0`. The
code, the API surface and the behaviour are unchanged in this release; it exists
to carry the licence change.

What changes for you:

- **Non commercial use stays free**, perpetually and irrevocably while you comply.
- **Commercial use now requires a paid licence.** The trigger is revenue, and it
  includes purely internal use inside a business that earns revenue.
- **If you deploy it, you publish the corresponding source.** That binds everyone,
  including paying customers, and cannot be bought out of.
- **Attribution is required of everyone** and cannot be waived.
- **Cooperatives, nonprofits, educational institutions, public bodies and worker
  owned businesses pay no fee.**

This is **source available, not open source**. It fails clause 6 of the Open
Source Definition because commercial use is conditional on payment. Automated
licence scanners report it as unknown, and GitHub shows it as "Other".

**Nothing here is retroactive, and it could not be.** `@oxy.so/api@1.0.3` was published
under MIT and stays MIT forever for anyone who has it. They may keep
using it, commercially, at no charge, indefinitely, and may fork it. A licence
change binds future versions only.

### `@oxy.so/db` had to move too

The Breathe License is **not compatible with the GPL or the AGPL**, in either
direction. `@oxy.so/api` imports `@oxy.so/db` in process, and `@oxy.so/db` was
`AGPL-3.0-only`, so relicensing this package alone would have produced a
combination distributable under neither licence. Oxy owns both, so this is a
decision rather than a negotiation, but it IS a decision the migration plan
never made: `@oxy.so/db` postdates that analysis and sits in no layer.

### `NOTICE` now carries real third party obligations

Attribution binds everyone under this licence, so `NOTICE` matters here in a way
it did not before. It records the bundled **GPL-3.0-or-later ffmpeg** binary (an
`optionalDependency` invoked as a separate process, which is aggregation rather
than linking, plus the source offer the GPL requires), the
**LGPL-3.0-or-later** native imaging library sharp loads, with its relinking
statement, and the elections on `node-forge`, `jszip` and `@zone-eu/mailsplit`,
where the alternative in each case is a GPL licence this package cannot accept.

**The standing rule that follows:** if anyone ever links ffmpeg, or any other GPL
library, INTO this process, the combination becomes a GPL derivative and this
package can no longer be distributed under these terms at all.

The major is bumped rather than the change being slipped into a patch. A licence
narrowing must never reach anyone through a routine install.

### Added

- A `LICENSE` carrying the full Breathe License text with its Parameters filled
  in, and a `NOTICE`.

### Still outstanding

- The Licensor's jurisdiction of incorporation, registration number and the
  governing law are **visible placeholders**. They are not guesses, and must be
  filled in before the commercial arm can invoice.
