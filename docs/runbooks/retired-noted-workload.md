# Retired Noted backend workload

Migration `0219_retire_noted_workload_binding` expires only the retired Noted
backend binding `01a12a46-0ab6-721d-86a0-c63669a4e9b6`. Noted's application
`6a37b3e71ddfd195b65681d2`, public client and external grants remain unchanged;
Nilo continues to serve Noted's MCP and its own workload remains active.

## Evidence and boundary

Read-only production inventory on 2026-10-25 at 11:10 UTC found no Noted service,
running task, ACTIVE task definition or IAM `oxy-noted-task` role. Its 118 old
task definitions are INACTIVE. The account's only EventBridge bus contained six
rules; no rule targeted a Noted task, and Scheduler had zero schedules. The two
application scheduler Lambdas target the live Mention service revision. Current
Noted source only deploys its frontend/desktop/sidecar, while infrastructure
explicitly routes `mcp.noted.oxy.so` through Nilo. The later same-day readback
confirmed the absent role and zero active Noted definitions again.

Evidence receipts are archived by the migration owner under
`first-party-core-tmp/retirement-audit/`: `launchers.json`,
`launchers-after-infra398.json`, `rollback-and-lambda.json`,
`scheduled-lambda-targets.json` and `source-reference-census.json`.
The root registry readback is `first-party-root/live-workload-registry-20261025/readback.json`.
These receipts contain references and statuses, never secret values.

This is independent of the fleet-wide legacy-v1 cutover. It does not enable that
cutover or remove its remaining operational gates. Administrators must not
recreate the old IAM role and reuse the historical binding to relaunch an old
backend; any replacement requires review of its actual runtime identity.

## Apply and verify

The normal protected-main migration workflow applies the single-row PRE
migration, with the shared lock/statement timeout and per-migration transaction.
Before merge/application, refresh the role/service/task/schedule absence and
read the exact binding tuple below. Production must still have that exact row
and NULL expiry (or the exact retirement expiry for a repeat). An absent row is
allowed by the SQL solely because fresh installations never had this workload.
Existing identity or expiry drift raises an error and rolls back this migration.

```sql
SELECT id, application_id, provider, subject, environment, expires_at
FROM application_workload_identities
WHERE id = '01a12a46-0ab6-721d-86a0-c63669a4e9b6';
```

Expected tuple: application `6a37b3e71ddfd195b65681d2`, provider `aws-iam`,
subject `arn:aws:iam::237343248947:role/oxy-noted-task`, environment `production`.
After apply, expiry is exactly `2026-10-25T00:00:00.000Z`. Live workload resolution
refuses expired bindings, including authority revalidation of issued tokens.
Read back the preserved public-client/application/Nilo rows and the migration
ledger hash. Keep the receipt with the deployment record.

The real PostgreSQL regression exercises fresh install, exact expiry, unchanged
repeat, every identity field drift, independently changed expiry, and unchanged
public-client/application/Nilo rows. The fixture owns its database so canonical
application IDs cannot collide with another suite's receipts.

## Exceptional rollback

Routine application-image rollback does not restore this retired workload.
Only a separately reviewed replacement backend/role with current identity
semantics can justify restoring it. Use an explicit transaction and lock the
exact binding row. Require the entire expected tuple above and exactly the
retirement expiry; then change only `expires_at` back to NULL and `updated_at`
to the current time. Reject a missing row or any independently changed value.
Do not delete/recreate the row, application, public client, grants or historical
attribution, and do not edit the applied migration or its ledger. Record both
the approved reason and exact before/after readbacks. This deliberately is not
an automatic rollback triggered by an unrelated deployment failure.
