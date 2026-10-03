# Authorized completion foundation — 2026-10-03

Foundation parent: `24653406f17289244fb3b1cecd3f548b146c40f5`, reviewed composed draft #1555 with terminal CI37079506204. That frozen draft is unchanged. This new foundation records the explicit session instruction in authorization.txt/json and sets the changed-source Forge row INACTIVE. The instruction was received approximately00:17UTC; recordedAt is the actual recording clock. The session relay is authorization evidence, not cryptographic identity inferred from the shared GitHub actor.

## Decisions and source boundaries

| Scope | Documented recommendation now authorized | Owner / reserved surface | Technical/data conditions still required |
| --- | --- | --- | --- |
| I01–I03 | Bot agent_key and RBAC governance; restrictive OAuth fallback; documented freshness/epochs | i04_handoff: auth/account/session services, contracts auth, core/server; migration0137 | Validate exact proposal choices, bot parity, reauth, revocation, ABA and in-flight responses |
| I06/I07 | P1 floor-proration with highest-period cap; P2 empty registry; P3 cumulative proportional reversal of new grants; FIFO new grants, opaque legacy | integration: billing/grants/products/query/SDK/Console; migration0138 after auth0137 | Explicit product/owner/app IDs and rules; remote provider evidence, replay, concurrent spend/refund and no double award; no invented prices/catalogue |
| I09 | Bounded technical pilot in capacity review062d: exact three gpt-oss deployment IDs;8192 input/2048 output;32 concurrent/5000 UTC-day production | coverage: inference policy/edge/metering tests, Kaana NULL producer and infra rollout; no DDL currently planned | Fresh exact deployment registry/binding readback, honest input bound, NULL producer before ingest, durable cost/replay/real reconciliation |
| Integration/I11 | One coordinated release and measured consumer adoption | coverage owns parent/body, composition and rollout; no parallel parent edits | Backend before SDK; published packages must include final auth+ledger source; native/SSO, consumers and rollback |

I09 deployment identities come from the pinned proposal, never a model label:

- dep_cerebras_gpt_oss_120b_observed_2026_09_01
- dep_groq_openai_gpt_oss_120b_observed_2026_09_01
- dep_openrouter_openai_gpt_oss_120b_observed_2026_09_01

The proposal is `062d4d30196727b51bcb93a3c6b6836bfdc5518e:docs/inference/internal-metered-capacity-review.md`; it is absent from the parent246 tree. Its historical catalogue snapshot is not current eligibility, pricing, residency, custody or provider-cost proof. Strict USD ceilings and tariff-proxy budgets require actual explicit values/provenance; none follows from this technical pilot.

## Composition and rollout order

1. Children rebase onto this new foundation; never merge it into their branches. Maintain file boundaries and reserve auth0137 then billing0138; regenerate migration metadata on the composed source, never hand-edit snapshots.
2. Review each source handoff, run meaningful local/PG checks, then compose all final auth/billing/inference source. Regenerate contracts/OpenAPI and verify old/new client compatibility.
3. Before final source freeze, validate local suites and CI functional checks, migration phases/fresh+repeat, actual rollback commands and exact published baselines. Forge audit must reject while INACTIVE; do not weaken it.
4. One final source freeze, exact ARM image, independent Forge consumer tests against changed inputs, authenticated artifact/collector and root review. Only declarative pins/decision differ afterward. Reactivate the same scoped authorization with original09Oct22UTC expiry, never extend it implicitly.
5. Root technical promotion: deploy additive backend and Kaana NULL producer in reviewed order, before first ingest/new SDK consumer. Verify fresh running immutable image/task/schema/bindings and rollback; then bounded real canaries and reconciliation. No old-format historical ingest first.
6. Build/test/pack final coordinated SDK packages and publish from the same build command according to package rules. Adopt actual published versions in consumers; verify domain authority, native/SSO and rollback.
7. Close a child only when all its original criteria are verified, without inventing merge as a criterion. Close parent after all children plus final integration checks. The session authorization already covers closure; do not ask for duplicate final approval.

Authorization removes policy approval blockers. Missing implementation, values, evidence or safe rollout remain technical/data conditions, not claims of completion.
