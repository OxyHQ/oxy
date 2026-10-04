# One-shot Alia budget smoke (root operator only)

This checks **Alia authority → published SDK → Oxy → Kaana** after #1579. It does not run the personal frontend or the Alia serving image. It uses the final Oxy image, published core4.3/contracts4.9.1, Alia's exact existing task role and its unchanged shipping credential factory staged with `O_EXCL`. No user identity is manufactured; the caller has no database, provider or signing secrets.

The preserved real Alia `Hello` fixture was built from source b2bc57f4 with SystemPromptBuilder, ToolPipeline (21 tools), and the AI SDK adapter. Fixture SHA256 fd9ef8fc783425e5285b100111bfe69fb0b27dd4346e81479bd57725c2003d77. Only `maxOutputTokens:128` and a newly generated `clientRequestId` change; routingProfile:auto, context, schemas and tool choice remain identical. Canonical Oxy normalization measures 29,027 controlled input units. The smoke never runs returned tool calls.

The current compiled Alia policy is checked before token exchange: economics2026-10-04.1, completion126976, decisions8192, output2048, capacity32/5000 and exactly the three approved gpt-oss120b deployments. Edge admission filters every executable route against that tuple set, including auto routing. The fresh SQL snapshot must cover those three exact deployment hashes and current USD prices, with the exact accepted privacy snapshots: Groq retains payloads for30 days, Cerebras/OpenRouter do not retain payloads (0 days); all three declare no training and ZDR availability. Availability is not a claim that this request has zero retention. This smoke contains only synthetic data. It must be <=5 minutes old at the POST. The conservative preflight tariff estimate prices 32,768 input units and 128 output/reasoning units at the higher partition price, plus one request, and refuses any route above USD0.02. This is neither an invoice guarantee nor an upstream retry-cost cap. Kaana's own signed retry/failover can create more than one provider attempt; the operator emits only one POST and performs no retry.

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

Root checks exact definitions before both dispatches: inventory has only canonical DATABASE_URL SSM reference and no task role; caller has only Alia task role and no secrets. The re-used SQL reader is byte-identical to the accepted I09 reader and uses one repeatable-read, read-only transaction; it performs no quote reservation or ledger write. CLI JSON inputs are private files, never `/dev/stdin`. An `O_EXCL` dispatch marker forbids running the same plan again, even with another output directory. Failure diagnostics record only the failing AWS action and bounded category/code, never raw stderr, tokens or request content. AWS mutation retries are disabled; stable clientToken binds the only RunTask request. SIGTERM triggers cleanup; SIGKILL/lost registration or dispatch ACK needs exact external reconciliation.

The caller verifies the live JWKS EdDSA signature and exact Alia app/owner/workload/environment plus invoke and usage-read scopes. TTL must be 300s, with >190s remaining. One SDK `respond` has an abort/deadline of180s; a subsequent SDK original-key GET has15s. No response/error/token text is logged; only metadata, usage, answer hash and quote. A returned text with stop and matching settled usage passes; length, tool_calls, missing answer, refusal, foreign receipt and missing receipt never claim restored conversation. An acknowledged response with missing usage remains incomplete, with its answer hash retained.

After unknown dispatch, first reconcile the original task/startedBy/clientToken/TD and original log packet. Never rerun caller or generate another intent. After task cleanup, a separately reviewed read-only recovery can preserve the original key:

```bash
python3 prepare.py --mode reconcile --binding /ABS/binding.json --inventory /ABS/fresh-inventory.json --original-plan /ABS/caller-plan/plan.json --output /ABS/reconcile-plan
AWS_PROFILE=oxy AWS_MAX_ATTEMPTS=1 python3 dispatch.py --plan /ABS/reconcile-plan/plan.json --output /ABS/reconcile-run
```

Recovery uses the original quote snapshot and only GET; it cannot restore lost answer text or declare zero cost from404. A recovered record is `usage_reconciled_result_missing`, not completed chat. Provider cost/attempt cardinality need separate exact SQL/feed observation; NULL remains unknown. No feed replay is needed for this budget smoke.

Local validation uses Node's test runner for these standalone operator scripts (not package tests): `node --test smoke.test.mjs` and `python3 test-transport.py`. SDK calls are real published4.3 methods with synthetic HTTP transport; tests do not perform production HTTP, AWS or provider calls. Preparation output remains `executionReady:false` until root reviews its live inputs.

Diagnostic-only follow-up: `prepare.py --mode diagnostic --binding <accepted binding> --inventory <retained inventory> --output <fresh directory>` stages the same shipping factory and verifies the minted JWT signature, exact identity and TTL. It reports invoke/usage-read booleans without constructing an inference client or calling responses/generations. Stale prices are reported and never authorize invocation. Normal invoke/reconcile still require both scopes. Failures expose only fixed stage/assertion codes; `emitIntentSent` tracks the local emission boundary, not provider execution. The original failed caller remains unreconciled until its exact SQL observation; missing send logs alone do not establish zero provider work.


## Prepared Auto/high follow-up (not a production binding)

This separate follow-up restores the original synthetic Hello builder's 2048-token output limit and leaves `routingProfile: auto`, all 21 tools, prompt/context, and reasoning selection unchanged. Auto's canonical rule raises >8 tools to high. A 128-token smoke used only 6.25% of the original ceiling and could truncate reasoning before visible text. There is no measured probability of a nonempty answer at either ceiling.

Preparation now requires `binding.policyModuleSha256` and `binding.routeReview` with the exact policy version, four distinct reviewed deployment/model/provider tuples (the historical three plus one high), each current price version ID and its precise privacy snapshot. `maxQuotePicos` is explicitly 20000000000 (USD 0.02) or, only after separate review, 50000000000 (USD 0.05). The smoke ceiling is independent of the runtime policy's maximum. The compiled policy's hash and complete tuple set are checked before mint/invoke; the ECS definition remains bound to the reviewed image. The reader selects only the supplied exact IDs, through a closed identifier grammar. Nothing labels a historical deployment as high.

The fourth route in local tests is named `synthetic_high_deployment`; it is not a proposed production route, grant, model review, or price. No new live binding or dispatch plan is included. After the actual high reader and deployment acceptance, root supplies the new image/TD and policy hash plus exact reviewed tuple/prices, prepares a fresh inventory, then a new caller plan. Original frozen smoke and all old plans remain unchanged. Reconciliation refuses a different original binding or price snapshot.

The per-request quote uses the maximum input/cached rate across 32768 input units, and maximum visible-output/reasoning rate across 2048 generated units, plus one request. This shared output ceiling requires the selected adapter's documented disjoint usage partition; it is not a provider invoice guarantee or proof of one upstream attempt. No new POST retries or tool execution are introduced. Success still requires nonempty text, finish `stop`, and the completed matching original-key receipt. A tool call, `length`, empty answer, or unknown receipt is not a restored conversation. A separate exact-intent SQL observation must confirm actual admitted/resolved/serving deployment and all direct/child attempts; NULL costs remain unknown.

Local validation: 45 Node controls (published SDK with synthetic transport; 12 new high controls) and 13 existing transport controls. No AWS, provider calls, real inference, or production state changes. Future root handoff still needs actual high route/privacy/price evidence, source/policy/image binding, fresh inventory, and independent review of the generated definition.
