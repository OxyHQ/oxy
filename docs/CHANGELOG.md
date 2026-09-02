# Oxy ID Initiative — Changelog

> The canonical "what changed and why" for the self-sovereign identity / civic
> identity / decentralization work shipped on top of the existing
> authentication platform. Chronological, newest-relevant-first within each
> phase. Commit SHAs are from `main`.
>
> Cross-references: [Identity](identity/README.md) · [Reputation](reputation/README.md) ·
> [Nodes / decentralization](nodes/README.md) · [Auth & session](auth/README.md) ·
> [Architecture](architecture/overview.md).

This initiative turned **Commons by Oxy** (`packages/commons`, a native-only
identity vault) into a citizen-identity / **"Oxy ID"** app backed by a
server-side civic engine in `oxy-api`. The thesis: **ownership of identity,
reputation and data comes from cryptography** (per-subject, hash-chained signed
records) — not from Oxy granting it. Commons is the user-facing face; the engine
lives in `packages/api/src/services/civic/` + `routes/civic.ts`; the SDK surface
lives in `@oxyhq/core` mixins; wire contracts live in `@oxyhq/contracts`.

The roadmap was built in numbered phases **F0 → F5**. F0–F4 plus the
DNI→"Oxy ID" rename, the Commons navigation restructure and the Reputation
screen redesign are **shipped, deployed and CI-green**. F5 (decentralization /
user nodes) is shipped through 5a/5b/5c on the API + a standalone node server,
with container orchestration and the Commons node UI deferred to infra/app work.

---

## PR #415 — Accounts/Commons split + self-sovereign identity foundation

The precursor to the civic phases: it split the keyless **Accounts** app from
the native-only **Commons** vault and introduced the DID + signed-records +
"Sign in with Oxy" foundation that every later phase builds on.

| SHA | Date | Summary |
|---|---|---|
| `6eed55f3` | 2026-06-26 | **feat(identity):** Accounts/Commons split + self-sovereign identity + "Sign in with Oxy". Accounts becomes keyless/management-only; all key/identity UX moves to `packages/commons`. Adds `did:web` documents (`did.service.ts`), signed records (envelope v1, `SignedRecord` model), signed data export, domain verification, and the QR + shared-keychain "Sign in with Oxy" handoff. |
| `403b18cd` | 2026-06-26 | **chore(api):** register the "Commons by Oxy" + "Oxy Auth" Applications/clientIds so their SSO origins are auto-approved. |
| `ca97cc7a` | 2026-06-26 | **chore(commons,auth):** wire the real Sign-in-with-Oxy client ids into Commons + the auth app. |
| `2ce09748` | 2026-06-26 | **chore(release):** publish the identity SDK — `@oxyhq/contracts 0.3.0`, `@oxyhq/core 3.11.0`, `@oxyhq/auth 5.1.1`, `@oxyhq/services 11.1.0`. `contracts 0.3.0` adds `identity.ts` (DID document, signed-record envelope, verified domain, auth-methods, export-bundle schemas). |
| `c38fcf19` | 2026-06-26 | **feat(did):** make the `did:web` anchor domain configurable via `DID_WEB_DOMAIN` env (default `api.oxy.so` → `did:web:api.oxy.so:u:<id>`). |

See [identity/README.md](identity/README.md) for the DID model, the signed-record
envelope, and the Sign-in-with-Oxy mechanisms.

---

## F0 + F1 — Signed-record hash chain + crypto-owned reputation

| SHA | Date | Summary |
|---|---|---|
| `37d11b69` | 2026-06-27 | **feat(civic): Fase 0+1.** **F0:** upgrades the signed-record envelope to **v2** (`version, seq, prev, collection, rkey`) — a per-subject, per-collection **hash chain** with a `RepoHead` O(1) head pointer; `signedRecordSigningInput`/`canonicalize` are shared client+server; `verifyEnvelope` gains the `subject`/`OXY_DID`/untrusted branch logic. **F1:** the Oxy ID card + **crypto-owned reputation** — users never self-award; they sign attestations and a civic service calls `reputationService.award(...)` in-process, emitting an Oxy-signed `reputation_attestation` record. Also: Commons "DNI" card + 3 native tabs, offline-first. |

F0 is the substrate every later phase rides on (see
[identity/README.md#signed-records](identity/README.md#2-signed-records-envelope-v2)).
F1 is the reputation foundation (see [reputation/README.md](reputation/README.md)).

---

## F2 — Anti-gaming: real-life attestation + validator jury

| SHA | Date | Summary |
|---|---|---|
| `5dc710d4` | 2026-06-27 | **feat(civic): Fase 2.** Real-life QR attestation (HIGH weight, **+25** `real_life_attested`, `physical` category): B scans A's `oxycommons://attest` QR, biometric-gates, signs an on-device attestation, POSTs `/civic/attest`; the server verifies both signatures + exclusion rules + awards. Plus a random **validator jury** (MEDIUM, **+8** `peer_validated`): weighted-reservoir selection with a stored `rngSeed`, graph/device/IP exclusion (`graphExclusion.ts`), quorum tally; correct/incorrect votes award `validation_correct` (+3) / `validation_incorrect` (-10). |

See [reputation/README.md#f2--anti-gaming](reputation/README.md#4-f2--anti-gaming-real-life-attestation--validator-jury).

---

## F3 — Proof of personhood + DNI→"Oxy ID" rename + Commons nav

| SHA | Date | Summary |
|---|---|---|
| `6780ad55` | 2026-06-27 | **feat(civic): Fase 3.** Proof-of-personhood as a multi-signal web-of-trust: signed **vouches** + staking (reversal slashes the stake, **-20** `vouch_slashed`), **sybil** clustering on shared fingerprints, random **audits** (reuse the F2 jury), and a biometric signal. `personhoodDerive.ts`: `evidence = 0.50·vouch + 0.35·realLife + 0.15·biometric`, threshold θ = 0.60 → sets `User.verified` → promotes the trust tier to `verified`. **Also** the clean-cut rename **DNI → "Oxy ID"** (zero "dni" anywhere; `oxydni://` → `oxycommons://`) and the Commons nav restructure (Home merged into the **ID** tab, scan = a Bloom **FAB** → fullScreenModal, **3 tabs**, active-tab tint = text color). |

See [reputation/README.md#f3--proof-of-personhood](reputation/README.md#5-f3--proof-of-personhood).

---

## F4 — Verifiable Credentials

| SHA | Date | Summary |
|---|---|---|
| `2a279044` | 2026-06-27 | **feat(civic): Fase 4.** Verifiable Credentials (NSID `app.oxy.credential`, one signed record per credential, `rkey` = credential UUID): user-issued (self-signed, `issuer===subject`) or org-issued (an Application's DID, `type:'internal'`/`isOfficial`). `verifyCredential` checks, in order: outer envelope against the issuer DID's **current** active verification method (rejects rotated/unlinked keys), `status !== revoked`, not expired. Routes: `POST /civic/credentials/issue`, `GET /list/:holderDid`, `GET /my`, `POST /verify`, `DELETE /revoke/:rkey`. |
| `9aaa3875` | 2026-06-27 | **fix(api):** replace a pre-existing `require()` with `import` in the DID tests to unblock CI lint. |

See [reputation/README.md#f4--verifiable-credentials](reputation/README.md#6-f4--verifiable-credentials).

---

## Commons UI — Reputation screen redesign + app-wide clean pass

| SHA | Date | Summary |
|---|---|---|
| `0a82e78e` | 2026-06-27 | **feat(commons):** redesign the Reputation screen into an "engine-room" layout — standing hero + Skia composition donut (per-category breakdown arc) + civic-duty CTA + signed activity ledger. |
| `c5e71986` | 2026-06-27 | **style(commons):** clean/spacious pass on the Reputation screen (Apple / World App aesthetic). |
| `705dc4d7` | 2026-06-28 | **style(commons):** app-wide clean UI pass — shared `components/ui` primitives applied across 13 Commons screens. |
| `9c44c1e3` | 2026-06-27 | **docs:** document the Commons civic layer (Oxy ID, Fases 0–4) + the F5 continuation handoff (`CONTINUATION.md`). |
| `dfef3a19` | 2026-06-28 | **docs:** F5 progress — 5a/node/5b shipped, 5c partial-then-verified, infra/UI/SDK tail. |

---

## F5 — Decentralization: user data nodes

The core invariant for the whole phase: **reads NEVER touch a node.** All node
I/O is background, via `safeFetch`. A node being down means stale-but-instant,
never slow. The node reuses the F0 hash chain and `@oxyhq/core` crypto verbatim.

| SHA | Date | Summary |
|---|---|---|
| `89ce0422` | 2026-06-28 | **feat(nodes): Fase 5a** — user-node **API foundation** (one-way Oxy→node). `UserNode` model + node-as-signed-record registration (a `type:'node'` record via `POST /identity/records`), public `GET /identity/log/:userId` + `GET /identity/head/:userId`, async liveness probe via `safeFetch`, a `#oxy-node` service entry in the DID document, `GET /nodes/me`. |
| `d9c74692` | 2026-06-28 | **feat(node): Fase 5** — `packages/node` / **`@oxyhq/node`**: a self-hostable Express data-node server (better-sqlite3 log + on-disk blobs) that reuses `@oxyhq/core` verify, enforces chain continuity, authorizes writes by the owner key, and ships with a Dockerfile + Caddyfile for TLS. |
| `c6fb8a86` | 2026-06-28 | **feat(nodes): Fase 5b** — node→Oxy **ingest**. Background `nodeSync` worker: `safeFetch` the node log, **verify every record** (envelope + chain continuity + owner DID), resolve conflicts by **LWW per `(nsid, rkey)`** (higher `issuedAt`, tiebreak `recordId`), **fork keeps both**, and **OXY counter-signs each ingested `recordId`** as an immutable witness against a stolen key rewriting history. `POST /nodes/ingest/notify` is a hint (no authority) that enqueues the pull (BullMQ / interval worker). |
| `964b265e` | 2026-06-28 | **feat(nodes): Fase 5c** — **managed vault**: `POST /nodes/managed` provisions an OXY-custodial node — Oxy signs the node record with the custodial key (`controller: 'oxy'`) so non-technical users get a "Create your vault" path without self-hosting. The container/storage orchestration of the managed endpoint is infra (deferred to `oxy-infra`); 5c only does the registration + custodial sign against `MANAGED_NODE_BASE_URL`. |

See [nodes/README.md](nodes/README.md) for the full node model, the ingest flow
diagram, and the deferred items.

---

## Cross-cutting platform changes shipped alongside

These landed in the same window and touch auth/SDK behavior every app sees.

| SHA | Date | Summary |
|---|---|---|
| `1d90ba37` | 2026-06-28 | **feat(api,auth,core,accounts):** dynamic CORS derived from the Application registry + a Google/Meta-style consent screen. CORS allow-lists are computed from active `Application.redirectUris` origins instead of a static seed. |
| `2cafc4a2` | 2026-06-28 | **feat(api):** `GET /users/:id/mutuals` — "followers you know". |
| `cfb9cf20` | 2026-06-28 | **feat(core):** `getUserMutuals` SDK method (`@oxyhq/core 3.14.0`). |
| `6a652c2e` | 2026-06-28 | **fix(sdk):** smart returning-user SSO bounce gating; remove `disableAutoSso`. Bumps `@oxyhq/core 3.15.0`, `@oxyhq/auth 6.0.0`, `@oxyhq/services 12.0.0`. The cold-boot `/sso` terminal bounce is now gated so first-time visitors are not bounced unnecessarily, while returning users still restore silently. |
| `a6b5dbec` | 2026-06-28 | **fix(api):** restrict the public identity-log export (#417) — tighten what `GET /identity/log/:userId` exposes. |
| `7bf423c0` | 2026-06-28 | **fix(api):** prevent personhood **re-vouch** reputation farming (#418) — a withdrawn-then-re-issued vouch can't re-award `personhood_vouched`. |

---

## Pending / deferred (not yet shipped)

Carried forward from [`CONTINUATION.md`](../CONTINUATION.md) §8 and the roadmap tail:

- **Managed-vault container orchestration** — spinning up per-user node instances
  behind `MANAGED_NODE_BASE_URL` is **infra** (`oxy-infra`), not application code.
  5c only registers + custodial-signs.
- **`@oxyhq/core` node SDK mixin + Commons node UI** — a "Connect your node" /
  "Create your vault" surface in Commons Settings. (If `OxyServices.nodes.ts`
  is present, the SDK side has landed; the Commons UI is the remaining piece —
  see [nodes/README.md](nodes/README.md).)
- **Publish `@oxyhq/contracts` 0.4.0 → core → services → auth** — only when an
  external app needs the new civic types. Commons consumes them as `workspace:*`
  and the API Docker build builds contracts from source, so no publish is needed
  for current deploys.
- **Infra (needs AWS):** set `REC_SCORING_V2=true` in
  `terraform-uswest2/app-services.tf`.
  (Two other items formerly listed here are resolved, verified against
  production: the karma→reputation migration is a no-op — every karma
  collection is empty cluster-wide, there is nothing to migrate; and
  `isSeedVerifier=true` is already seeded on the bootstrap trust accounts.)
