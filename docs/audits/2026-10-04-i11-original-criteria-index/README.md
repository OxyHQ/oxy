# I11 original-criteria evidence index

This index links existing accepted evidence; it adds no test, rollout gate or
claim that a public health probe proves an authenticated commercial operation.
The global ledger and issue1527 remain owned by coverage. I05 and I08 integrated
acceptance remain separately evaluated by root; no closure is inferred here.

| Original criterion | Existing evidence |
|---|---|
| Published, resolved and deployed consumer matrix | [I04 acceptance, 18 product consumers](https://github.com/OxyHQ/oxy/blob/d11a99ae5/docs/audits/2026-10-04-i04-acceptance/proof.json) pins each final manifest/lock, registry archive/member checks and results. [Examples final](https://github.com/OxyHQ/examples/blob/ba29314/docs/audits/2026-10-04-final-registry/proof.json) adds Next/Vite/Expo; main2bfc9197 has the accepted tree. Root fleet/frontends and workflow restoration receipts are separate operational evidence. |
| HTTP/MCP and live permission boundaries | I04 source/package/consumer proofs cover common InvocationHandlers, discriminated principals, errors/deadlines and tools/list not granting tools/call. [I03 live acceptance](https://github.com/OxyHQ/oxy/blob/747bc8da9/docs/audits/2026-10-04-i03-result-reconciliation/root-accepted.json) records two independent warm receivers denying after revocation, with expiry excluded. I05 retains its own exact configuration/catalog and product parity gates. |
| Human/bot subject, identity and consent | Closed I01/I02 accepted fixtures in the final composition; published web and Android replays accepted by root37c0123a/99bec5e7. No requirement is invented to create a new production human session. The browser asset-routing and Android shared-provider/recovery limits remain in the original receipts. |
| Products/bundle, financial idempotency and recurring payments | Closed I06 and I07 accepted proofs retain ledger, product-specific access and provider test evidence. Clarity's two-product SQL/HTTP selection proof10d880 is composed into final registry adoption. Mercaria's Peable0.2.2 adoption and lifecycle/HTTP/UTF-8 tests are composed; I08's final cohort cycle is still evaluated separately. |
| Internal metering and external billing preservation | [I09 final original-criteria audit](https://github.com/OxyHQ/oxy/blob/093713be0/docs/audits/2026-10-04-i09-final-acceptance/README.md): one real request, same-key409, exact authenticated feed and duplicate-only replay; positive cost/external charging/failover remain separately identified integration controls. |
| Replacements before removing duplication | Noted and Homiio use canonical linked raw responses, preserving envelopes/deadlines/multipart/abort and session lifetime. Mercaria removed its equivalent custom Peable HTTP client and local webhook HMAC in favor of published SDK surfaces; non-equivalent marketplace/refund/payout behavior is explicitly classified, not deleted blindly. Final per-consumer registry proofs are in the I04 matrix. |
| Regression and rollback | Accepted final source/CI/package tests plus per-consumer image, migration and runtime receipts. The old-issuer/DDL142 rehearsal retains its maintenance/quiescence limits; it does not claim issuer rollback alone closes offline receiver or background financial lanes. Original failures and approved bounded exceptions stay in their proofs. |

## Active-account MCP subcriterion

- **Noted:** [0569162d proof](https://github.com/OxyHQ/Noted/blob/0569162d/docs/audits/2026-10-02-mcp-active-account/evidence.json) uses the real app wrapper/handlers, HTTP MCP and owned PostgreSQL. Private notes/labels follow active B, not origin A; revoked authority refuses. The final adoption branch contains this source and published MCP1.1.0; I04's matrix records registry/CI separately.
- **Mercaria:** [975e680a proof](https://github.com/OxyHQ/Mercaria/blob/975e680a/docs/audits/2026-10-02-mcp-active-account/evidence.json) tests actual store membership/permissions and SQL ownership as B, keeps audit actor A, and refuses revocation on the next call. Refund authorizer tripwire never executes a financial effect. Final registry adoption composes this change.
- **Inbox:** the server is Oxy `packages/api/src/capabilities/inbox-mcp-http.ts`, not the frontend-only Inbox repository. Its actual authorize callback returns `principal.activeAccountId`; its adapter test supplies origin account-1 / active account-2 and asserts account-2. Common MCP authority tests cover revoked/changed principals and refusal before effects. These are adapter/common-transport tests, not a newly claimed live Inbox account-switch session.
- **website:** actual `server/mcp/catalog.ts` judges admin access by the active account. `server/mcp/http.test.ts` exercises the real HTTP application/database and refuses an admin origin acting as non-admin active account; revoked/expired/wrong-resource/wrong-audience tokens write zero rows. Final registry adoption and runtime artifacts are separately accepted. The common SDK `consumerAccountBinding` test is explicitly a reduced policy projection, not passed off as these product tests.

No new source adaptation is needed merely because a historical checkbox still
names these already-tested callbacks. Whether to mark a broader I05/I08 composite
checkbox complete depends on that daughter's accepted criteria, not this index.
