# Bootstrap the reviewed Kaana catalogue

This is the production-safe path for creating the exact Oxy catalogue facts
already reviewed in `kaanaInitialCatalogue.ts`: the gpt-oss text routes and
their eight profiles, and Alia's text-to-speech route (`x-ai/text-to-speech`
on `dep_xai_tts_observed_2026_09_24`) with its speech-only profile
`cc2471c8-807e-46ec-b5da-b6f3b39d2db5` (`kaana-v1-speech`, ranked on price) — and,
once Kaana has published it, xAI's realtime Voice Agent route
(`x-ai/grok-voice-think-fast-2.0` on provider `xai-realtime`; see
[Enabling the xAI realtime voice route](#enabling-the-xai-realtime-voice-route)).
It does not enable an inference
audience, change an application's classification, create a reviewer or move a
provider key.

Run only [Bootstrap reviewed Kaana catalogue](../../.github/workflows/bootstrap-kaana-catalogue.yml)
from `main`. The workflow uses GitHub OIDC through the dedicated
`oxy-github-kaana-catalogue-bootstrap` role and the persistent
`oxy-kaana-catalogue-bootstrap` task definition; it never derives a writer from
the live `oxy-api` task.

## Prerequisites

1. Apply and read back the exact reviewer authorization described in
   [Bootstrap the Kaana catalogue reviewer](./bootstrap-catalogue-reviewer.md).
   This workflow accepts only the source-reviewed PostgreSQL `users.id`
   `6981c9178fcdefaf81988ffb`; it never grants staff status or discovers a
   reviewer by username, display name or order.
2. Deploy the matching Oxy `main` image, then renew the dedicated bootstrap task
   definition through reviewed infrastructure so it pins the same immutable
   image digest. An older revision is not usable merely because its family name
   matches.
3. The GitHub OIDC role must have `ecs:RunTask` and exact `iam:PassRole` for both
   `oxy-ecs-execution` and `oxy-kaana-catalogue-bootstrap`. Keep the latter exact;
   do not widen it to a path or wildcard.
4. Keep `kaana-publisher` healthy. Copy its complete live network configuration
   to the one-shot, including `assignPublicIp`. Both public-subnet `ENABLED`
   and private-subnet `DISABLED` are valid; never force a public IP after the
   publisher moves behind NAT.
5. Verify the current Kaana inventory content snapshot is the one pinned by
   `KAANA_INITIAL_INVENTORY_SNAPSHOT_ID` (and the workflow's
   `INVENTORY_SNAPSHOT_ID`): `snap_37548e4f1f8ec610` until the voice route is
   enabled. The task role can read only the versioned `inventory/current.json`
   object and the writer refuses stale or mismatched content.

The task definition is also checked before every run: one ARM64 Fargate
container, exact command and image, exact inventory object and task role, and
one secret binding — PostgreSQL `DATABASE_URL`. Provider keys, signing keys,
application credentials, static AWS credentials and MongoDB are outside this
lane.

6. Apply any pending same-value scorecard renewal first
   ([routing score renewal](./kaana-routing-score-renewal.md)). The bootstrap
   refuses an existing scorecard that is not at its current reviewed state.

The job binds no GitHub `environment:`. The OIDC role trusts only the
`ref:refs/heads/main` subject, and an environment-bound job presents
`environment:<name>` instead and cannot assume it.

## Dry run, then apply

Choose `dry-run` and supply:

- the exact live `oxy-api` task-definition ARN;
- the exact dedicated bootstrap task-definition ARN;
- their shared immutable `sha256:` image digest;
- the exact authorized reviewer `users.id`.

The task takes a PostgreSQL transaction advisory lock, locks the reviewer row,
validates every exact model, revision, deployment, routing-profile PK and
candidate, hashes all source-reviewed pricing, score, policy and profile facts,
computes `planSha256`, and rolls the transaction back. Review the allow-listed
operation list, source-facts SHA and retain the plan SHA.

Choose `apply` with the same identities, the retained SHA and a single-line
change reason. The workflow always performs a fresh dry run first, then
re-attests the live rollout and passes that attestation (timestamp, both task
definitions, image, cluster, service) to the one-shot, which refuses APPLY
unless it is under ten minutes old and repeats the ECS proof itself. Both the
workflow and the writer inside the still-rollbackable transaction require the
fresh SHA to equal the reviewed SHA. After commit, the workflow runs the exact
Inbox profile query inside a PostgreSQL `READ ONLY` transaction, then performs
another rollback-only bootstrap and requires `inserted: []`.

An apply with a non-zero exit, absent result or malformed result is ambiguous:
the workflow runs the SELECT-only readback, reports whether the exact row is
present, exits failed and does not retry or declare success. Review the database
state and obtain a new dry-run plan before any later apply.

## Identity is not audience eligibility

Every reviewed deployment is `availability_scope = platform_internal`: reviewed
for official Oxy products under `standard_application_use`, never for public
resale. Staff-classified `first_party`, `internal` and `system` applications see
that scope ([catalogue.md](../inference/catalogue.md#reads-are-audience-scoped));
third-party applications and plain user bearers do not. A successful bootstrap
and exact-PK readback prove the profile identity and candidate, not that a
given product may route through it. Before setting
`INBOX_INFERENCE_ROUTING_PROFILE_ID` or enabling execution, prove the exact
profile resolves to at least one route for the real Inbox principal.

Do not relabel an application's tier and do not rewrite an approved
deployment's scope as a shortcut.

### Text routes still stored as `internal_alia`

The three gpt-oss deployments, written before the rename, still store the
legacy `internal_alia` bytes: the storage rename's backfill is a
separate migration
([rolling storage rename](../inference/catalogue.md#rolling-storage-rename-three-releases-in-order)).
The bootstrap compares an existing row's legacy `internal_alia` as the
`platform_internal` it means and never rewrites it; any other stored scope is
still drift. Rows it inserts, such as the speech route, are written as
`platform_internal`. The Cerebras and Groq routes also keep the approval note
written on 2026-09-02 (`Owner-approved initial internal Alia route; …`): it is
the record of that decision and the reviewed facts pin its exact bytes.

### Existing scorecards after migration 0082

The two original Cerebras/Groq scorecards may carry
`funding_evidence_ref = migration/standard-payg`: migration 0082 backfilled that
exact value into both current rows and immutable events, then removed the SQL
default. Bootstrap preserves that historical marker for those exact deployment
IDs only. It still checks every other reviewed field and requires the matching
immutable event to carry the same marker; it never rewrites either row. Newly
created scorecards, including OpenRouter, require the reviewed price URL.

## Enabling the xAI realtime voice route

The reviewed voice catalogue — model `x-ai/grok-voice-think-fast-2.0` with
`realtime_transports = {websocket}`, `realtime_session_kinds = {conversation}`,
text+audio in and out, `api_formats` NULL; provider `xai-realtime` (Kaana's own
slug, which `session.created.servingProvider` must equal); price version at
xAI's list price with no markup: `audio_input_milliseconds` and
`audio_output_milliseconds` at `0.08` per `60000`, `requests` at `0.004` per `1`;
a single-route scorecard; no routing profile (a session names its model) — is
source-reviewed in `packages/api/src/config/kaanaInitialCatalogue.ts`
(`kaanaVoiceCatalogue`). It is **gated**: `KAANA_VOICE_OBSERVATION` is `null`,
the dry run reports `voice: null`, nothing of it is planned or written, and
`requireKaanaVoiceCatalogue()` refuses.

Two production facts do not exist until Kaana's publisher observes the model in
production, after the Kaana/oxy-infra rollout of `xai-realtime`
(`kaana_xai_realtime_enabled`, the credential row, the discovery key id). Never
invent either; read both from the live inventory object:

| Fact | Where it comes from | Shape |
|---|---|---|
| deployment id | the `deployments[]` entry with `provider: "xai-realtime"`, `upstreamModelId: "grok-voice-think-fast-2.0"`, `modelReference: "x-ai/grok-voice-think-fast-2.0@observed-<YYYY-MM-DD>"`, `current: true` | `dep_xai_realtime_grok_voice_think_fast_2_0_observed_<YYYY_MM_DD>` |
| inventory snapshot id | that object's top-level `snapshotId` | `snap_<16 hex>` |

The same snapshot must still carry the four existing reviewed routes with their
exact facts — the writer refuses it otherwise.

**The follow-up commit** (one PR, nothing else changes):

1. `kaanaInitialCatalogue.ts`: set
   `KAANA_VOICE_OBSERVATION = { deploymentId: "<id>", inventorySnapshotId: "<snap>" }`.
   The revision (`observed-<YYYY-MM-DD>`), model reference, operations and the
   bootstrap-wide snapshot pin (`KAANA_INITIAL_INVENTORY_SNAPSHOT_ID`) are all
   derived from it. An id that is not Kaana's `xai-realtime` grok-voice id, a
   date before the 2026-09-30 review, or a malformed or pre-voice snapshot keeps
   the gate closed and fails `kaanaInitialCatalogue.test.ts`.
2. `.github/workflows/bootstrap-kaana-catalogue.yml`: set `INVENTORY_SNAPSHOT_ID`
   to `<snap>` and `VOICE_DEPLOYMENT_ID` to `'<id>'`, and the two matching exact
   assertions (`[ "$INVENTORY_SNAPSHOT_ID" = … ]`, `[ "$VOICE_DEPLOYMENT_ID" = … ]`).
   A test fails unless both files carry the same two values.
3. CI green, merge, deploy that `main` image and renew the dedicated bootstrap
   task definition to the same digest (Prerequisite 2).

Then run the workflow exactly as above: `dry-run` — confirm
`inventorySnapshotId` is `<snap>`, `voice.deployments == ["<id>"]`,
`voice.providers == ["xai-realtime"]`, and that `inserted` is exactly the voice
operations (`model:x-ai/grok-voice-think-fast-2.0`, `revision:…@observed-<date>`,
`provider:xai-realtime`, `price:…:xai-realtime`, `deployment:<id>`,
`scorecard:<id>`; `publisher:x-ai` exists already) — retain `planSha256`, then
`apply` with it. The post-apply no-op dry run proves the route equal.

The route is `platform_internal` like every reviewed route: first-party staff
applications (Alia) can open sessions on it; nothing else can. Its scorecard
carries the shared `KAANA_INITIAL_SCORE_VALID_UNTIL`; renew it with the others.
Before announcing it, run the realtime signed canary against `<id>`
([kaana-signed-canary](../../.github/workflows/kaana-signed-canary.yml),
`probe_mode: realtime`) and one push-to-talk session through `/v1/realtime`
whose receipt carries `audio_*_milliseconds` and `requests` at these prices.
