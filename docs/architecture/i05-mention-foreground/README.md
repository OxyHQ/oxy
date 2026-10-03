# Mention foreground profile caller configuration

This is a preparation packet, not a live permission change. The fixed selector
names Mention application `6a2f851751b784a86fd0e916`; names, slugs and a caller's
free application ID confer no authority. Readback must identify the actual
workload binding and its inert canonical credential before a compare-and-set.

## Fresh read-only observation

The launcher forks the previously reviewed read-only authority transport. It
pins live Oxy task definition `oxy-oxy-api:692`, the actual image digest,
execution role, network and the single existing DATABASE_URL reference. Its
inventory task has no task role, other secret, sidecar, port or environment
value. It verifies returned and described task definitions before dispatch.
Prepare is read-only AWS metadata; execute is a separate operator step after
review of that exact plan. Cleanup verifies STOPPED task and INACTIVE definition. Before RunTask, a private,
fsynced `dispatch-attempt.json` records the exact registered definition, plan
commitment, full startedBy nonce and stable ECS client token. An uncertain ACK
never causes a second dispatch: bounded metadata reconciliation searches RUNNING
by startedBy and STOPPED by our own family, then verifies exact startedBy and
definition on DescribeTasks. All identified exact tasks are cleaned up; even a
successful cleanup leaves an explicit review error. Absence from eventually
consistent listings does not prove that no task launched. Preserve the attempt
and reconcile its exact handles before any later execution.

The initial preparation with SHA
`1a957487524a9282313fa65bffc44e82f05cd259260ec2be5513800c2ed7e4bf`
is invalidated by this launcher correction. No AWS write used that plan. The
reader produces `mention-foreground-preflight`, which the launcher now requires;
it rejects the predecessor service-authority protocol. Offline tests execute the
actual Node packet encoder and launcher path with synthetic AWS responses, not
an ECS task or SQL query. They do not establish live dispatch or IAM success.

AWS documents [RunTask client-token idempotency](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ECS_Idempotency.html)
and the [ListTasks filter contract](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ListTasks.html).
The recovery uses the startedBy filter alone, then a separate family/STOPPED query;
this avoids combining incompatible filters.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/agency/mention-foreground-preflight-ecs.py oxy --plan /private/mention-foreground-plan.json
# Operator reviews plan/source/definition hashes and live pins before this step:
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/agency/mention-foreground-preflight-ecs.py oxy --plan /private/mention-foreground-plan.json --execute --output /private/mention-foreground-result
```

The reader uses the image's resolved PostgreSQL dependency in a repeatable-read,
read-only transaction with timeouts, at most 20 rows per fixed projection and
128 KiB total. It reads current scopes, capabilities, xmin, owner/status/fences,
workload provider/subject/ceiling, inert attribution credential and `oxy`
registrations. No public key, secret or verifier is selected. Financial and
user tokens are absent. Results with row IDs/role subject remain private;
public reporting contains counts, hashes and discrepancies only. Missing table
or column is explicit and cannot authorize a compare-and-set.

## Minimal proposed delta, after complete fresh readback

Mention's existing ordinary scopes and capabilities stay intact. Add only a
missing `capability-tickets:issue` to its application scope ceiling and to the
verified workload binding's explicit scope ceiling, and missing
`agency:coordinate` to the application capabilities. `user:read` must already
be demonstrably present in the caller intersection; do not convert an unrelated
role into Mention or expand another subject. Existing `capabilities:read` is
needed to discover the reviewed catalogue. A live bearer still proves the
requester; this does not grant `acting-as:offline` or create consent.

`catalog:oxy` and `catalogs:write` belong only to the canonical Oxy registrar.
They are never part of the Mention execution delta. Fresh readback identifies
that registrar and any active `oxy` registration. Register the exact canonical
profile catalogue using that Oxy service/workload identity; capture its actual
registration id/version/digest. Inbox's separate registration is preserved.

The apply transaction must lock and compare the exact application, owner,
workload and inert credential rows to fresh expected revisions and values,
including liveness, trust, closure fence and provider/subject. Any mismatch
aborts with no update. The rollback restores only the added scopes/capability,
only if those same rows still equal the applied state; concurrent operator
changes abort rollback rather than being overwritten. Do not prepare executable
CAS values from the earlier inventory: it omitted application capabilities.

The consumer's `MENTION_OXY_FOREGROUND_CATALOG_BINDING` configuration will contain
the actual registration id/version/digest from readback. It enables only the
common foreground read path. Backend migration 0141 and the SDK exports are
prerequisites. Package candidates and a complete read-only inventory do not
prove registry publication or consumer pilot acceptance.
