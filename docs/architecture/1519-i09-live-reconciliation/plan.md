# I09 live Oxy admission and Kaana-feed reconciliation

Prepared against candidate `38571f1c2df87ce2a7439841d0dfcf61bc1e438e`.
This is an execution plan, not an executed canary or a production acceptance.
Root performs the reviewed operations after the final backend is steady. The
issuer-only baseline remains TD692/image4512; its drain is already complete.

## Exact caller and admission

Use one ephemeral task in the existing Alia network and the existing
`arn:aws:iam::237343248947:role/oxy-alia-task`. Pin its currently running image
and task-definition shape immediately before preparing the task; source/tag
association does not attest installed bytes. Inspect the installed core package
and the deployed `createOxyInferenceCredential` entry point before calling it.
The helper is the real Alia factory: a complete OXY_SERVICE_API_KEY/SECRET pair
configures OxyServer serviceAuth; with neither it uses workload attestation.
Do not introduce a pair or silently switch its actual lane. Keep only the
required OXY_API_URL and, if present in the actual lane, those two existing secret
references. Do not load the app, database or unrelated provider credentials.

Mint through this helper/OxyServer, keeping the bearer only in memory. Require
its verified identity to match Alia application `6a2f851751b784a86fd0e934`,
production environment and the existing service-token lane. Check live app,
credential/workload status and `inference:invoke` ceiling. No X-Oxy-User-Id,
requester session, new grant, offline impersonation or fabricated balance is used.
Minting has the existing bounded authentication side effects (lastUsedAt/rate
limits); the inference itself can incur upstream cost. This is not read-only.

Before invocation, root captures a minimal live catalogue/routing/price readback:
model `openai/gpt-oss-120b@observed-2026-09-01`, active revision, eligible routes,
policy/version and quoted or explicitly unpriced tariff. The only pilot tuples
are:

| Deployment | Provider |
| --- | --- |
| dep_cerebras_gpt_oss_120b_observed_2026_09_01 | cerebras |
| dep_groq_openai_gpt_oss_120b_observed_2026_09_01 | groq |
| dep_openrouter_openai_gpt_oss_120b_observed_2026_09_01 | openrouter |

Compare these tuples to the current signed Kaana deployment registry and Oxy
eligibility; no guessing from semantic labels. Recheck the canonical
`https://kaana.ai` binding, approved audience, exact signing key reference and
feed-reader configuration. A missing route/price/binding is a preflight failure,
not permission to seed a replacement. Jev/Auto and decision gates remain separate.

## One controlled request and its retry

Generate one fresh bounded Idempotency-Key/clientRequestId in the
`oxy1519-i09-<timestamp>-<nonce>` namespace. Assert no prior metered row for that
caller/key. Through the real Alia credential helper call the canonical Oxy
`POST /v1/responses`, redirects refused, 60s deadline and bounded response body:

```json
{
  "model": "openai/gpt-oss-120b@observed-2026-09-01",
  "input": "Reply with OK.",
  "maxOutputTokens": 16,
  "stream": false,
  "clientRequestId": "<the prepared exact identifier>"
}
```

Do not print the bearer or generated text. Retain HTTP status, exact requestId,
provider/model, routing version, usage units, finish reason and elapsed time.
The 16-token upper bound is below the approved pilot cap. The controlled UTF8
budget is not a certified provider framing/hidden-prompt/billing token ceiling.
One admitted operation may have an actual failover attempt set; record every
attempt rather than pretending a successful HTTP200 proves there was only one.

Send the identical body/key once more using the same legitimate caller. The
existing contract returns 409 `idempotency_conflict`, not a cached 200. Require
exactly one admitted/settled metered operation under that caller/key and no new
upstream attempt attributable to the rejected retry. A timeout is not permission
to allocate a different key and spend again: first inspect the original key.

## Durable readback and feed replay

Before the first invocation capture the feed cursor, caller-specific money row
counts/digests and any prior rows for the prepared key. Read only explicit
columns through the existing owned/pinned database reader pattern. Afterward
require the exact metered row to preserve caller/account/environment attribution,
`internal_metered`, relationship `alia-kaana`, policy
`oxy-inference-economics/2026-10-03.3`, admitted and final deployment, settled
outcome and actual usage. A refused request is recorded honestly and does not
complete the success criterion. No financial usage receipt/reservation or balance
mutation is allowed for this internal operation; compare the captured state.
An unpriced tariff and unknown upstream cost stay NULL, never become zero.

The final server already calls `startProviderCostFeedSchedule`; there is no
separate feed activation flag. Its first 60s interval occurs during rollout when
the existing Kaana binding is configured. Capture cursor/rows before deployment
and observe this automatic ingestion, rather than claiming the feed stays off
until the canary. Both API tasks may race; cursor CAS and attempt uniqueness are
the existing controls.

Use the existing signed `createHttpKaanaProviderCostFeedReader` to retain the
actual events for this exact requestId, starting at the pre-invocation cursor and
within its existing 20-page/500-item bounds. Observe the scheduled SQL rows keyed
(requestId, attemptIndex), complete actual attempt set, served/failure outcome,
provider/deployment/model, unitsMeasured, exact costs/source and facts digests.
If the bounded feed cannot locate the exact request, stop with that limit visible.

Replay only those authenticated original events once through the existing
`ingestProviderCostAttempts`. Require inserted=0, mismatches=0 and duplicates
matching the event count, unchanged exact row digests/counts and unchanged money
state. Do not rewind the global cursor or invent an event from a guessed amount.
Capture a subsequent cursor readback; progression due to unrelated traffic is
separate from the exact per-request idempotency proof.

## Cleanup, rollback and acceptance limits

Both ephemeral tasks use pinned reviewed source/installed modules, minimal
environment, existing execution permissions and inherited log/network paths.
The inference task retains the exact existing Alia role to exercise its real
lane. The database/feed task needs only the existing DB/signing references;
no new IAM or provider credential is authorized by this plan. Root checks task
and override bytes before run, handles stop and deregister independently in
finally, confirms STOPPED/INACTIVE and records unconfirmed cleanup honestly.
No long-lived service/scaling change is part of this canary.

If deployment must roll back, TD692/image4512 keeps the 300-second issuer and
drain. Removing the new API image stops its feed reader; no nonexistent flag is
used. Preserve all new ledger/feed/session history. The separate old-runtime
against schema141 rehearsal and write-stop/adoption plan must establish what
new session/capability/ledger operations to stop before rollback; an ARN alone
is insufficient. Unknown cost is a remaining unknown, not zero-cost success.

This scenario proves one real app-only Oxy admission, its actual upstream
attempt set, durable usage and exact feed replay. It does not certify the whole
fleet, provider tariffs, production p99 revocation, all pilot concurrency/day
limits, or user-delegated inference. Local tests cover those mechanism negatives;
production acceptance records their own scope.
