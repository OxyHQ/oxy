# Mercaria billing authority: prepared operation, not applied

I08's published Peable SDK0.2.0 requires `payments:read` for merchant identity
and subscription reads, and `payments:write` for the four billing mutations.
This operation only prepares that service authority. It enables no cohort,
creates no merchant/plan/price, changes no MoR and grants no user delegation.

The root read-only production inventory (2026-10-03 04:39, private receipt
`root-1519-20261003/authority-inventory-0439/result.private.json`) identifies:

| Field | Exact target |
| --- | --- |
| application | `6a37d0cc5d4b5f15482a9340` |
| owner account | `69b2d3df5d12f58c9800d651` |
| service credential | `01a061cd-39a9-7bd6-ba31-70ef7590c953` |
| environment/status | production / active, no expiry |
| existing scopes on both | user:read, catalogs:write, capabilities:read, capability-audit:write |
| additions to both | payments:read, payments:write |

Public credentials and all other application fields remain untouched. The seed
spec adds only these two scopes so future controlled reconciliation preserves
the intended ceiling. **Do not run the whole seed against production:** it can
reconcile unrelated fields. The existing generic credential script is not used
for this operation because it has no joint application/credential CAS or rollback.

## Transaction and attribution

The internal service locks owner SHARE → application UPDATE → credential UPDATE;
checks active owner and absence of closure fence; verifies exact owner/app link,
first_party application, active production service credential without expiry;
and compares exact scopes, `updated_at::text` and PostgreSQL `xmin::text` for both
rows. `xmin` detects ABA even if scopes and timestamps are restored. The plan is
short-lived operational evidence, not a durable application version or an auth
claim; vacuum/freeze or any row rewrite may conservatively invalidate it.

Apply changes only scopes and updatedAt in one transaction. Constraint/second
update failure rolls back both writes. Rollback consumes the applied receipt,
requires the exact resulting versions and scopes, and restores the previous
scope arrays with new timestamps; concurrent edits cause refusal. Lock timeout
is5s and statement timeout10s. No requests to another service occur inside TX.

This is an operator-only DB seam like the existing workload binding operation,
not an HTTP authorization route. The script obtains STS caller identity and
requires the reviewed exact `EXPECTED_OPERATOR_ARN` in account237343248947.
Root must independently authorize this DB operator/session and retain the receipt.
STS attribution does not grant DB access or prove a customer is an app member.
The customer-only credential audit table has no scope-change event and must not
receive a fabricated customer/rotation record. This operation emits a private
operator receipt; it does not claim a database audit event.

## Reviewed execution sequence (root only, no execution in this change)

1. Root captures fresh application/credential readback and authenticates the
   operational AWS/DB session. Secret values, hashes and tokens are not output.
2. Run `bun packages/api/scripts/reconcile-mercaria-billing-authority.ts prepare`
   with `DATABASE_URL`, `EXPECTED_OPERATOR_ARN`, and a unique `AUTHORITY_OUTPUT`
   under a0700 private evidence directory. No scope update occurs.
3. Review `<output>.result.json` against the exact target/six scopes and retain
   SHA256. `apply` additionally requires `AUTHORITY_INPUT` pointing at that plan
   and `AUTHORITY_INPUT_SHA256`; use a fresh output path. Root coordinates timing.
4. Read back both rows independently. Refresh the existing SDK service-token
   cache via the reviewed deployment/restart or wait for its expiry; validate a
   fresh token's scopes and merchant namespace without logging the token.
5. If reverting, use `rollback` with the applied receipt plus its SHA256, again
   a fresh output path, then read back. A rollback is not a promise that already
   issued service tokens disappear immediately: verify authority at the deployed
   gateway and coordinate cache/token expiry before declaring access removed.

Outputs use exclusive0600 creation reserved before DB access, fsync, a pending
record and a separate result file. No automatic retry. If commit succeeded but
receipt persistence failed, the pending marker/empty result means **unknown**;
inspect the database read-only and reconcile exact state before any next write.
Do not rerun apply or fabricate a rollback receipt from an assumption.

## Remaining cohort gates

Production Mercaria's identified credential is production-mode; a test merchant
would require an existing matching test credential, verified merchant and exact
owned store cohort. The six empty commercial tables do not establish whether
such a store or Peable merchant exists. Peable TD7 currently has no Stripe/cohort
configuration. No test or production cohort identity is invented by this change.
Root must verify account/mode on both deployments, bindings, exact merchant/app/env,
approved store allowlist and effective Portal config before enabling billing.
