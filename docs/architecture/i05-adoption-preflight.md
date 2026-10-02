# I05 Alia / Mention adoption preflight

Read-only consumer diagnosis, 2026-10-02 UTC. Current remote heads were verified
as Alia `2927daa376cb37e25f3d021d880efc48e650ce7f` and Mention
`cbdba7f9ba077d239019114f2a88e2d1ef392cf1`; sources were read from those Git
objects, not the differing shared checkout heads. I04 source input is
`5130d8827152fa54befffa5d05f7695c7f853d57`; the transport followup uses composite
base `a33c316ad3fb17cb4d9eed5b78b4c3f7d58854a4`.
[35 source inputs](../audits/1519-i05-internal-invocation-2026-10-02/source-inputs.json)
pin path/blob/SHA. No Alia or Mention source has been changed by this preflight.

## Existing flow and minimum future files

| Source at the pinned head | Existing contract to preserve | Proposed bounded adoption |
| --- | --- | --- |
| Alia `packages/api/src/lib/tools/oxy-services.ts` | `callBoundTool` issues short proof, never sends user bearer to products; stable SHA-256 key at lines374–382/514–520 uses run/tool/callId or canonical arguments; steps/audit and transient authorization teardown remain | Retain registry binding `{registrationId,version,digest}` instead of stripping it from catalog discovery; issue through common agency with `expectedCatalog`; invoke approved pilot through shared MCP client with the same operation key; handle `isError` and transport failures separately |
| Alia `packages/api/src/lib/oxy-capability-authority.ts` / `oxy-service-client.ts` | Direct execution requires explicit requester bearer; preauthorized agent work keeps exact resource/tool/run/step | Reuse `OxyServer.agency` without turning coordinator service authority into user authority; retain direct authorization revocation and background binding |
| Mention `packages/mcp/lib/tool-registry.ts` | `definitions()` and `invoke()` own canonical schemas/controllers; current symbol is `invoke`, not the issue's historical `execute` | Project the same definitions to shared invocation handlers, retaining policies and tool outputs; do not recreate domain tools |
| Mention `packages/mcp/server-http.ts` / proposed `lib/internal-mcp.ts` | External OAuth and existing native HTTP/SSE callers remain; managed deployments have distinct registered app/audience/resource | Mount opt-in internal MCP before body consumption using exact registered catalog binding and common live verifier; preserve existing routes until parity/actual adoption is established |
| Mention `lib/context.ts`, `lib/api-client.ts`, `lib/capability-http.ts` | Native proof is forwarded only to Mention backend under request-scoped AsyncLocalStorage; `X-Oxy-Capability-Tool` and existing operation key remain; root check at capability-http31–36 requires `resourceId===effectiveAccountId` | Resolve account-root resource from verified capability principal; project verified request headers into ephemeral forwarding context, never args/logs/global credentials. `RequestHandlerExtra.requestInfo.headers` already contains the same HTTP proof; this is not an absent-ticket API |
| Mention backend `capabilityAuth.middleware.ts` / `capabilityEffectIdempotency.middleware.ts` | Backend independently validates live proof, exact route/tool/account/limits; durable receipts reserve account/coordinator/actor/key/fingerprint before effects and refuse duplicate/conflict | Upgrade strict claim decoder before receiving pinned tickets; keep middleware and receipt semantics, not a replacement ledger |

Alia still invokes other products that have not mounted internal MCP. A pilot
must explicitly bind a reviewed app/catalog to the new transport; do not switch
every catalog to `/_oxy/mcp` or infer transport readiness from branding. The
actual pilot selection/rollout configuration remains a review item before
consumer implementation. Existing cache/freshness policy and I03 decisions
remain separate; a stale binding must fail ticket issuance, not widen authority.

## Upstream gaps prepared before consumer code

The I04 client previously had no per-call key option. The approved followup
adds a validated header option and receiving `required` enforcement without
making initialize/tools-list effectful. The resource callback previously hid
the verified principal in its public type even though runtime supplied it; it
now exposes a capability-only context. These changes are source/packed fixture
preparation, not a published SDK dependency.

## Product acceptance to run after approval and real release

Extend Alia `packages/api/src/lib/__tests__/oxy-services.test.ts` to exercise
the shared client over real HTTP: requester bearer only to Oxy control plane,
one exact catalog binding, user-vs-standing execution authorization, same
callId/retry key versus deliberate new callId, step correlation/error mapping
and finally-revocation on success/failure/abort. No coordinator fallback can
authorize another account/resource or unlisted tool.

Extend Mention `packages/mcp/__tests__/{capability-http,capability-catalog}.test.ts`
and add internal transport parity tests using canonical registry handlers.
Compare input/result/error across current HTTP, internal MCP and external OAuth.
Preserve external connection-management tools as MCP-only. Prove originA/activeB
and native requester/owner/actorA/effectiveB remain distinct; wrong app/tool/root,
catalog digest, revocation and domain permission loss refuse before effects.

Use Mention's real backend middleware and disposable PostgreSQL receipt service
for replay/concurrent duplicate/conflicting fingerprint/new authorized intent;
do not claim those guarantees from the transport's simulated effect set.
Existing backend tests are
`src/__tests__/mcp/{mcpEffectIdempotency,mcpEffectReceiptService}.test.ts`.
Use each package's scripts: Alia API `bun run test` / `bun run test:pg`, Mention
MCP `bun run test` (its configured runner is Bun), backend `bun run test`, plus
their build/typecheck scripts. A test plan here is not evidence of execution.

## Versions and release gates

[Registry snapshot](../audits/1519-i05-internal-invocation-2026-10-02/registry-current.json)
at20:46UTC: contracts4.8.0, core4.1.0 and MCP1.0.0 are latest published.
Mention declares contracts4.7.0/core4.1.0/MCP^1.0.0 through catalog/overrides;
Alia API declares contracts^4.4.0/core^4.0.0 and no MCP dependency. None proves
availability of the new internal transport APIs.

Require coordinated actual releases containing the discriminated/pinned ticket
contract, common agency/live verifier and these transport APIs. Upgrade both
Mention MCP and backend strict decoders before opting into catalog-bound tickets.
Only then select explicit published dependency minimums, commit manifests and
lockfiles together, build/typecheck and repeat standalone packed checks. Local
tarballs with current version numbers are candidates pinned by SHA, not releases.
No version number or commercial policy is selected here. I04/I05 acceptance,
legacy retirement, release/deployment and production parity remain pending.
