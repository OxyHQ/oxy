# I09 original-criteria acceptance

I09 is complete within its approved internal Alia → Kaana pilot. The published
and deployed Oxy API693 and Alia449 performed one real inference through the
existing authenticated workload identity. The caller received HTTP 200 and the
same intent received 409. The final exact reconciliation found one settled
internal-metered usage row and one provider attempt, matched the authenticated
feed, and replayed that existing event through the canonical writer: zero
inserts, one duplicate, zero mismatches, unchanged rows and four money-table
fingerprints. All final tasks stopped successfully and temporary definitions
became inactive.

| Original criterion | Evidence and scope |
|---|---|
| Authenticated policy and metering contracts | Deployed versioned `inferenceEconomicPolicy.ts`; policy tests reject request-borne classification, other lanes/environments and non-internal apps. Existing workload authority was retained. |
| Internal positive provider cost without charge, external billing preserved | `inferenceMeteredUsage.service.test.ts` proves positive failed/served costs (0.012 fixture total), unknown costs separately and zero internal receipts. `inferenceEdgeInternalMetered.test.ts` exercises internal execution without balance/profile/hold and external charging in the same installation; unfunded external and forged body/header classifications are denied. These positive-cost/external examples are controlled integration fixtures, not new live customer charges. |
| Idempotency and technical budgets independent of balance | SQL concurrency/daily limits and exact pilot controls have accepted evidence in the approved-pilot proof. The live caller's same-key retry is 409; no second inference was performed by reconciliation. |
| Durable cost, feed replay, failed attempts and failover | Source SQL/feed tests preserve failed and served attempts, reject changed duplicate facts, and keep unknown costs NULL. Live post proves exact feed digest equality and duplicate-only replay with unchanged records. |
| Later prices do not rewrite history | Canonical SQL test snapshots cost centre/policy/tariff and changes the later price without altering the settled row; repeat settlement and conflicting receipt repairs cannot rewrite it. |
| Additive design and scoped rollout | Existing additive migrations and policy were promoted with API693, preserving commercial paths and historical rows. Only the approved app/environment, three deployment identities and existing workload authority were used. No new grant, price or provider activation was invented. |

The real Groq request reports input 75, output 2, reasoning 14 and one request.
Its upstream provider cost is **unknown (NULL)**. The separately quoted tariff
is neither provider cost nor a customer charge. The live evidence does not claim
a positive measured upstream cost, a provider invoice, a percentile latency,
all human traffic, or an unrestricted model/provider rollout.

The earlier unknown RunTask dispatch remains unknown historically. Its definition
was fenced inactive and current absence reconciled before a new post attempt.
The following post task failed the overly strict final-Auto-route guard. The
read-only diagnostic identified legitimate NULL final overrides for explicit
admission. The corrected external guard has frozen RED/GREEN and canonical
image693 SQL evidence in the adjacent route-reconciliation audit. None of these
failures is relabelled success, and none caused a second inference.

`root-accepted.json` is the exact sanitized root acceptance receipt; its reference
paths identify private source packets by hash. The manifest also pins original
criteria, prior controlled-test evidence, actual source and failed-attempt
receipts. No credentials, private signing keys, prompts or raw response bodies
are published here.
