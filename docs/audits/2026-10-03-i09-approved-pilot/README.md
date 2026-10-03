# I09 approved production pilot — local source evidence

Nate approved the documented recommendations on 2026-10-03. The exact proposal
is [`062d4d3019`](https://github.com/OxyHQ/oxy/blob/062d4d30196727b51bcb93a3c6b6836bfdc5518e/docs/inference/internal-metered-capacity-review.md).
This implementation does not certify provider tokens or approve a monetary tariff.

The edge guards the real `alia-kaana` relationship: 8192 conservative controlled
input budget, signed output capped to 2048, and every authorized route restricted
to the three exact deployment/model/provider tuples. Existing 32 simultaneous /
5000 UTC-day admission limits remain. Commercial callers retain their behavior.

## Reproduction and measured scope

`red-harness.ts` freezes the exact added HTTP tests before implementation, against
runtime `49bdc15d0`: 3 failed /16 passed. Both oversized ASCII and Unicode inputs,
and an unapproved route, previously received 200. To reproduce, copy the archived
harness to `packages/api/src/routes/__tests__/inferenceEdgeInternalMetered.test.ts`
in a separate checkout of that runtime and run the owned harness below. This
archive is historical source, not another test suite executed from this folder.

From the repository root, after frozen installation and builds of db/telemetry:

```bash
python3 scripts/rehearsal/test-approved-api-1519.py src/routes/__tests__/inferenceEdgeInternalMetered.test.ts src/config/__tests__/inferenceEconomicPolicy.test.ts src/services/__tests__/inferenceInternalPilot.test.ts src/services/__tests__/inferenceMeteredUsage.service.test.ts src/services/__tests__/kaanaProviderCostFeed.service.test.ts
```

The runner scrubs inherited URLs/libpq settings, starts its own PostgreSQL17
on 5576 and verifies PID/UID/executable/data/socket ownership before creating
an isolated database. Jest applies all 136 migrations. It always stops its server;
no production connection is accepted. API build uses its package command and
builds workspace dependencies in order; scoped ESLint uses zero warnings.

Production-pilot HTTP cases use the actual relationship/configuration and SQL
catalogue records with canonical tuples. Kaana execution/attestation remain fixture
implementations. Altered catalogue records in mismatch/alternate tests are explicit
controlled negatives. Older mechanism/Auto/scoped tests use an explicitly synthetic
relationship without the production pilot and do not certify its rollout gates.
Provider usage and rates are synthetic, not real provider invoices or approved prices.

Verified locally: original RED guards, Unicode/tool/schema/overhead boundaries,
exact tuple matching, signed output old4096/new2048/512/omitted, commercial4096,
excluded alternates, mismatched model/provider, and concurrent duplicate refusal.
Metering/feed tests preserve unknown-vs-zero and cost provenance/reconciliation.

## Rollout gates retained

Signed current registry readback, Kaana #150 NULL-preserving producer deployment,
Oxy backend/migration readiness, live correlated usage/cost and final integrated
image/Forge proof remain required. Jev/Auto/decisions gates stay independent.
Backend precedes SDK publication. See `docs/inference/internal-metering.md` for
ordering and reversal. No deployment, inference-provider call, SDK publication,
policy activation or I09 closure is claimed by this local proof.
