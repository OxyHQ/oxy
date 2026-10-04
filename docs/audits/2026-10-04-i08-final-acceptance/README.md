# I08 original acceptance completed

Peable#87's approved recurring scope is complete. ROOT accepted Peable9 and
Mercaria61 for the existing exact merchant/application/production/live Stripe
cohort and two existing stores. Mercaria source80291 and image36b6 retain the
existing financial responsibility and the legacy/global action gates disabled.
No new price, product, subscription, charge, refund, settlement or commercial
terms were introduced by this cutover.

| Original acceptance | Evidence and limit |
| --- | --- |
| Coverage and gaps checked | Approved five-method BillingProvider contract, source/SQL fixtures and provider sandbox. |
| Recurring financial contract approved | Exact existing Mercaria cohort, same platform account and mode, existing MoR retained; other merchants' policies are outside this issue. |
| Signup/renewal/payment authentication/failure/cancel/refund/reconciliation sandbox | Checkout sandbox3c48a87 and TestClock47753d6 accepted by ROOT; actual test-mode Stripe, real HTTP/SDK/SQL, explicit synthetic Oxy authentication. Requires_action is observed, not bypassed. |
| Subject/receipt attribution, replay and reordered events | Store/customer/price/mode bindings and SQL/idempotency/rollback/ingress fixtures accepted; historical records are not reattributed. |
| Published SDK and Mercaria adoption | Actual SDK0.2.2/shared-types0.3.0 publication and adoption; the serving ARM image has all53SDK files byteequal to the public archive, plus965 owned Oxy SDK files. |
| Authorized cohort transition | Actual Mercaria61 task9550, image36b6,1/1 COMPLETED, healthy ALB target; own new task log emitted the exact cohort hash, live/production/storeCount2. Both /health and /health/ready return200 without cookies/redirects. |
| Issue/parent synchronization | This original-criteria matrix and proof support the final Peable87 body/checklist and closure; the parent remains governed by its other children. |

The exact positive cohort SHA256 is
`a7ed9819eb8aa2e8360a430c907092e0af2059a8f9539bafc8eb780771046ed3`.
Readiness alone did not prove installation: ROOT independently checked the
actual new task's structured positive line, selected image/TD, configuration,
existing secret-reference aliases and target health. Peable9's exact merchant
and limited live Portal were already accepted. The135 historically reconciled
comment-only hashes plus23 unchanged rows form the complete158-entry journal;
all317drizzle files remain byteequal, no new DDL or ledger rewrite was needed.

The first operator used nonexistent /ready and returned404 after the successful
rollout. Its failure stays preserved. ROOT reconciled the SAME deployment with
the canonical /health/ready path; no registration/update repeated, no count0 or
automatic old-image rollback. The external helper correction has identical
HTTP fixture RED14pass/1error→GREEN15; it is a loopback route-topology fixture,
not a product bootstrap. Root's actual serving acceptance is separate.

[Matrix](matrix.json), [sanitized live projection](live-projection.json) and
[hash-bound proof](proof.json) distinguish provider sandbox, SDK/SQL fixtures,
and live cohort configuration acceptance. There is no remaining original I08
product criterion. A new human live purchase or new commercial catalogue is
not required by the approved bounded scope. Provider sandbox proves financial
method behavior; this live cut proves configured exclusive authority and the
installed adapter, without claiming a new live financial transaction.
