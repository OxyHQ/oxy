# I07/I08 bounded operator handoff

These external helpers prepare the remaining destination readback and the existing Mercaria technical merchant namespace. They do not modify the frozen Oxy source, publish packages, create a price/cohort, infer Oxy One composition, or run automatically. Root reviews fresh plans and operates them serially.

## Post-DDL inventory

Run after the selected services are stable on their reviewed images and Oxy has migrated through 0142. Use the **actual** task-definition revision captured from each service; there is no default historical revision. Preparation uses read-only AWS metadata. Execution launches one database-only read-only task with the exact existing execution role, digest, network, log prefix and sole DATABASE_URL reference; no task role, server, migrations or provider credentials are present.

```bash
python3 -B scripts/operations/billing-live-acceptance/commercial-inventory-ecs.py oxy --definition oxy-oxy-api:ACTUAL_REVISION --plan /PRIVATE/oxy-plan.json
python3 -B scripts/operations/billing-live-acceptance/commercial-inventory-ecs.py clarity --definition oxy-clarity-api:ACTUAL_REVISION --plan /PRIVATE/clarity-plan.json
python3 -B scripts/operations/billing-live-acceptance/commercial-inventory-ecs.py mercaria --definition oxy-mercaria:ACTUAL_REVISION --plan /PRIVATE/mercaria-plan.json
```

Create each PRIVATE parent with mode0700, owned by the operator. Plans are0600, exclusive, fsynced; review their raw file SHA256, launcher/reader hashes and exact digest/definition/configuration. For each profile, execute once with its same definition and hash:

```bash
python3 -B scripts/operations/billing-live-acceptance/commercial-inventory-ecs.py oxy --definition oxy-oxy-api:ACTUAL_REVISION --plan /PRIVATE/oxy-plan.json --plan-sha256 RAW_FILE_SHA256 --execute --output /PRIVATE/oxy-result
node scripts/operations/billing-live-acceptance/compare-commercial-inventory.mjs --oxy /PRIVATE/oxy-result --clarity /PRIVATE/clarity-result --mercaria /PRIVATE/mercaria-result --output /PRIVATE/comparison.json
```

Oxy's fixed whitelist is17 tables, including all provider-period/event and credit invoice/spend/consumption/refund destinations. Mercaria projects seven tables, including stores and all owner memberships. Clarity retains its two subscription/customer projections. Rows are private and bounded; output comparison contains counts/status only. The snapshot is READ ONLY/REPEATABLE READ with statement/lock/idle timeouts and to_regclass/schema checks. A missing table, legacy stripe_invoice_id fallback, incompatible column shape, unexpected census, incomplete cleanup or mismatched receipt blocks acceptance. Nonzero destination rows require explicit mapping/reconciliation; this tool performs zero writes. Two stores/owners are separate from paid-commercial counts.

The earlier production inventory observed no existing commercial rows and missing predeployment destinations. It does not establish the final database state, empty Stripe inventory, a configured product catalogue or a successful postdeployment backfill. If the new complete projections remain empty, report a verified zero-row comparison. Preserve ambiguous/nonzero legacy records and supply an actionable mapping discrepancy; never reconstruct opaque credits.

Before RunTask, a durable intent binds nonce/clientToken/startedBy/definition. A lost RunTask response can leave an unknown task even if the temporary definition is INACTIVE. Do not repeat execution: reconcile the original nonce/startedBy/definition against tasks, establish STOPPED and then inspect SQL/readbacks. Cleanup of every acknowledged task and definition is independent; successful readback requires STOPPED and INACTIVE with no failures.

## Mercaria authority and ephemeral credential

Use the existing accepted CAS transport, not a new user or grant:

* `/home/nate/Oxy/oxy/.worktrees/1519-mercaria-authority-transport-20261003/scripts/auth/mercaria-billing-authority-ecs.py`, head22fc678eef27f85471978dbb217b72c68cb4a9b3 and its README: fresh read-only prepare → reviewed apply → exact scope/xmin readback, rollback on drift. Target Mercaria application6a37d0cc5d4b5f15482a9340, owner69b2d3df5d12f58c9800d651; preserve all other rows. Root operates authority separately.
* Final-source `scripts/auth/mercaria-ephemeral-ecs.py` and `docs/auth/1519-mercaria-ephemeral-credential/README.md`: canonical local material generation, prepare/readback and a new owned development credential with exactly payments:read/payments:write, expiry≤1h, no rotation of an existing credential. Inspect/revoke consume the original prepare and a fresh inspect receipt respectively. The coordinator binds this launcher plus its original inventory transport/reader byte hashes; it does not replace those dependencies with this new inventory helper.

Keep the canonical prepare receipt, issue receipt and local material0600 in0700 parents. The material contains the only plaintext secret; it is never copied to task environment/arguments or evidence. Authenticated STS operator provenance is required; there is no fabricated staff bearer. Use a current reviewed API definition exposing the compiled canonical operation.

## Published SDK merchant operation

The operator verifies the registry0.2.2 metadata/integrity/archive SHA256 and every one of its53 installed SDK files before loading the actual ESM SDK. Archive SHA256 is68687dabc8caddcdb3f60d846d720f5103d29c4d2a0eacb774ebc08ca37f4494. It uses the real SDK `merchants.retrieve()` and `merchants.register({})` with real fetch. The fetch observer restricts URL/method/body/count, redirects, streamed response size and expiry; it forwards provider responses unchanged. Only configured HTTPS api.oxy.so and api.peable.to receive credentials. It never substitutes authority or logs/persists bearer, raw secret, headers or response bodies.

Write a private Node preparation configuration with exactly:

```json
{"archive":"/PRIVATE/registry-sdk-0.2.2.tgz","ephemeralIssue":"/PRIVATE/issue/result.private.json","material":"/PRIVATE/material.json","registry":"/PRIVATE/registry.json","sdkRoot":"/PRIVATE/installed/node_modules/@peable.to/sdk"}
```

```bash
node scripts/operations/billing-live-acceptance/merchants-register.mjs prepare /PRIVATE/merchant-config.json /PRIVATE/merchant-plan.json
```

This preparation is file-only. The plan fixes Mercaria's app/owner, development namespace, exact credential/expiry/material verifier and SDK/source hashes; validity≤30min and never beyond the credential. Root must then prepare the **coordinator**, rather than invoke Node execute directly. Coordinator config fields:

```json
{"merchantPlan":"/PRIVATE/merchant-plan.json","merchantPlanSha256":"RAW_FILE_SHA256","ephemeralPrepare":"/PRIVATE/prepare/result.private.json","ephemeralPrepareSha256":"RAW_FILE_SHA256","material":"/PRIVATE/material.json","ephemeralLauncher":"/REVIEWED/scripts/auth/mercaria-ephemeral-ecs.py","ephemeralLauncherSha256":"SOURCE_SHA256","transportSha256":"ORIGINAL_TRANSPORT_SHA256","readerSha256":"ORIGINAL_READER_SHA256","definition":"oxy-oxy-api:ACTUAL_REVISION","operatorArn":"ACTUAL_STS_OPERATOR_ARN"}
```

```bash
python3 -B scripts/operations/billing-live-acceptance/merchants-register-coordinator.py --config /PRIVATE/coordinator-config.json --plan /PRIVATE/coordinator-plan.json
python3 -B scripts/operations/billing-live-acceptance/merchants-register-coordinator.py --execute --plan /PRIVATE/coordinator-plan.json --plan-sha256 RAW_FILE_SHA256 --output /PRIVATE/merchant-operation
```

Preparation checks files only; execution is a separately reviewed effect. The credential already exists before coordinator execution. If initial plan validation fails, no child starts and the operator must retire that credential via the canonical inspect/revoke procedure. After admitted execution, finally always attempts exact credential cleanup, including Node failure or parent interruption. Child termination is awaited before cleanup. A forced kill or missing canonical ECS acknowledgement remains unresolved: inspect durable intents and reconcile before retry. Successful cleanup requires a canonical fresh inspect and revoked readback; it preserves the merchant and retains local material for explicit operator removal after receipts are checked. Previously issued JWTs can remain valid until their≤300s expiry.

The registration budget is one POST{}, at most two mints and three merchant reads. Initial existing merchant requires no POST. Lost registration response/conflict consumes the only POST budget and is reconciled by GET; no mutation retry. Readback requires merchant app=Mercaria, environment=development, network/xpub=null and no webhook URL. This establishes a technical merchant namespace only: provider payments, production terms, store bindings, cohort and prices remain unclaimed. HTTPS issuer claim projection is checked, not independently signature-verified by this observer; Peable performs its own JWT validation.

## Acceptance gates and remaining effects

1. Root obtains complete postDDL projections and a comparison, including two existing stores with their actual owner memberships. The tool does not create stores/cohort or infer entitlement mapping.
2. Root applies and reads back the exact existing Mercaria authority delta, creates one owned ephemeral development credential and executes the reviewed coordinator. Preserve SDK published0.2.2 evidence, returned merchant id and canonical revoke receipt.
3. Independently read actual provider account/mode and Portal feature configuration through the existing deployed secret reference, without extracting its value. The historical sandbox account is not proof of production identity. No new product/price or Portal mutation is implicit here.
4. Verify published Oxy SDK/Console reads against the real catalogue and payer/beneficiary/source after rollout, preserving subject-bound caches and named-source cancellation semantics. Empty confirmed commercial inventory means no historical backfill writes; it does not replace catalogue/access acceptance.

I06 is already functionally accepted separately. I07/I08 remain open until these actual destination/provider/SDK results satisfy their original criteria. These helpers have not performed any live read, authority mutation, merchant registration or deployment.

## Local validation scope

The transport suite uses AWS stubs, not AWS. The15 Python fixtures cover fixed definitions, all17 Oxy projection identifiers against generated0142, coordinator cleanup ordering/unknown ACK and a real local child interruption; the canonical ECS cleanup phases are stubbed receipts. The12 Node fixtures load the actual published SDK and use local HTTP with synthetic issuer responses; they exercise one POST/existing/lost-response/conflict/expiry/URL/body/count/stream bounds. Seven comparison fixtures use synthetic projected SQL results. These checks do not establish real SQL execution of the added destination whitelist or real provider authority.
