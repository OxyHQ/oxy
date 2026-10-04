# One-shot Alia budget smoke (root operator only)

This checks **Alia authority → published SDK → Oxy → Kaana** after #1579. It does not run the personal frontend or the Alia serving image. It uses the final Oxy image, published core4.3/contracts4.9.1, Alia's exact existing task role and its unchanged shipping credential factory staged with `O_EXCL`. No user identity is manufactured; the caller has no database, provider or signing secrets.

The preserved real Alia `Hello` fixture was built from source b2bc57f4 with SystemPromptBuilder, ToolPipeline (21 tools), and the AI SDK adapter. Fixture SHA256 fd9ef8fc783425e5285b100111bfe69fb0b27dd4346e81479bd57725c2003d77. Only `maxOutputTokens:128` and a newly generated `clientRequestId` change; routingProfile:auto, context, schemas and tool choice remain identical. Canonical Oxy normalization measures 29,027 controlled input units. The smoke never runs returned tool calls.

The current compiled Alia policy is checked before token exchange: economics2026-10-04.1, completion126976, decisions8192, output2048, capacity32/5000 and exactly the three approved gpt-oss120b deployments. Edge admission filters every executable route against that tuple set, including auto routing. The fresh SQL snapshot must cover those three exact deployment hashes and current USD prices, with approved permission/privacy. It must be <=5 minutes old at the POST. The conservative preflight tariff estimate prices 32,768 input units and 128 output/reasoning units at the higher partition price, plus one request, and refuses any route above USD0.02. This is neither an invoice guarantee nor an upstream retry-cost cap. Kaana's own signed retry/failover can create more than one provider attempt; the operator emits only one POST and performs no retry.

Prepare an exact `binding.json` from root's accepted final Oxy TD/image and Alia452/image3dff readbacks, using `kind:alia-budget-smoke-accepted-runtime-v1`, `oxyDefinition`, `aliaDefinition`, `image`, `executionRoleArn`, `taskRoleArn:arn:aws:iam::237343248947:role/oxy-alia-task`, `runtimePlatform:{cpuArchitecture:ARM64,operatingSystemFamily:LINUX}`, `network`, `cpu`, `memory`, `logGroup:/oxy/ecs`, `logStreamPrefix`, `budgetSource:27ebf33872c4e3c6e72e97a728f157d42a8ffaf2`, `coreVersion:4.3.0`, `contractsVersion:4.9.1`, and `sdkInferenceModuleSha256:82948cfb580242f2aedbb9438fb6fcb920cd51c4da1de79eadbf7ab08fdeac9b`. The runtime image must independently match those accepted shipping bytes. No example task revision or digest is authorized.

All paths below must be new root-owned evidence directories. Preparation is local only; **dispatch registers and runs one task**, and is for root after source/plan review:

```bash
python3 prepare.py --mode inventory --binding /ABS/binding.json --output /ABS/price-plan
AWS_PROFILE=oxy AWS_MAX_ATTEMPTS=1 python3 dispatch.py --plan /ABS/price-plan/plan.json --output /ABS/price-run
# Root verifies result.private.json.result.inventory readOnly/all tables complete,
# task STOPPED/image/exit and cleanup INACTIVE, then writes that inventory alone
# to /ABS/fresh-inventory.json (0600). Do not use an old I09 snapshot as current.
python3 prepare.py --binding /ABS/binding.json --inventory /ABS/fresh-inventory.json --output /ABS/caller-plan
AWS_PROFILE=oxy AWS_MAX_ATTEMPTS=1 python3 dispatch.py --plan /ABS/caller-plan/plan.json --output /ABS/caller-run
```

Root checks exact definitions before both dispatches: inventory has only canonical DATABASE_URL SSM reference and no task role; caller has only Alia task role and no secrets. The re-used SQL reader is byte-identical to the accepted I09 reader and uses one repeatable-read, read-only transaction; it performs no quote reservation or ledger write. CLI JSON inputs are private files, never `/dev/stdin`. An `O_EXCL` dispatch marker forbids running the same plan again, even with another output directory. AWS mutation retries are disabled; stable clientToken binds the only RunTask request. SIGTERM triggers cleanup; SIGKILL/lost registration or dispatch ACK needs exact external reconciliation.

The caller verifies the live JWKS EdDSA signature and exact Alia app/owner/workload/environment plus invoke and usage-read scopes. TTL must be 300s, with >190s remaining. One SDK `respond` has an abort/deadline of180s; a subsequent SDK original-key GET has15s. No response/error/token text is logged; only metadata, usage, answer hash and quote. A returned text with stop and matching settled usage passes; length, tool_calls, missing answer, refusal, foreign receipt and missing receipt never claim restored conversation. An acknowledged response with missing usage remains incomplete, with its answer hash retained.

After unknown dispatch, first reconcile the original task/startedBy/clientToken/TD and original log packet. Never rerun caller or generate another intent. After task cleanup, a separately reviewed read-only recovery can preserve the original key:

```bash
python3 prepare.py --mode reconcile --binding /ABS/binding.json --inventory /ABS/fresh-inventory.json --original-plan /ABS/caller-plan/plan.json --output /ABS/reconcile-plan
AWS_PROFILE=oxy AWS_MAX_ATTEMPTS=1 python3 dispatch.py --plan /ABS/reconcile-plan/plan.json --output /ABS/reconcile-run
```

Recovery uses the original quote snapshot and only GET; it cannot restore lost answer text or declare zero cost from404. A recovered record is `usage_reconciled_result_missing`, not completed chat. Provider cost/attempt cardinality need separate exact SQL/feed observation; NULL remains unknown. No feed replay is needed for this budget smoke.

Local validation uses Node's test runner for these standalone operator scripts (not package tests): `node --test smoke.test.mjs` and `python3 test-transport.py`. SDK calls are real published4.3 methods with synthetic HTTP transport; tests do not perform production HTTP, AWS or provider calls. Preparation output remains `executionReady:false` until root reviews its live inputs.
