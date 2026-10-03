# Consumer registration preflight — 2026-10-03

No application or credential has been created by this source change. SDK packs
used in consumer compatibility checks remain candidates; deployment remains a
separate, coordinated operation.

## GoWay: explicit normal public-client registration

The complete authority inventory at 17:57:54Z contained no GoWay application.
The real GoWay frontend already expects `EXPO_PUBLIC_OXY_CLIENT_ID`; its canonical
workflow forwards that public variable, which was absent. Register GoWay through
`packages/api/scripts/seed-oxy-applications.ts`, using the new immutable
`GOWAY_APPLICATION_ID=73176d04c3654667138c23ec` entry. It is `first_party`, official,
non-internal, with only `user:read`, no capabilities, and the exact website and
redirect origin `https://goway.to`. No service credential, workload, user grant,
new owner, or native callback is introduced.

The operator must use the reviewed final source/image containing the spec, an
existing legitimate operator identity, and the existing database boundary.
Verify the canonical `oxy` account against the authenticated inventory owner
before running; a username default is not evidence of ownership. Preserve an
attempt receipt before any write.

1. Fresh read-only check: neither the exact application ID nor any application
   named GoWay exists; validate the owner row and closure/status. Capture IDs and
   xmin. Refuse collision or contradictory identity rather than adopting it.
2. Run the canonical seed with `OXY_USERNAME=oxy`,
   `ONLY_APP_IDS=73176d04c3654667138c23ec`, `DRY_RUN=1`; require exactly one selected
   app, one proposed application and one proposed public production credential,
   and no reconciliation of existing rows. Preserve the dry-run output.
3. Recheck absence immediately before the serialized write. Invoke the same
   command with `DRY_RUN=0` once. The seed is not a globally atomic registrar:
   app creation and credential creation are separate writes. Lost ACK or partial
   completion requires a readback by exact ID and manual reconciliation, never an
   automatic repeat or new identity.
4. Read back the application and its single public credential, with xmin for
   each, owner/creator, type/status, scopes, redirects, environment, expiry and
   public client ID. Require active production public credential, no secret or
   expiry, and the exact declared authority. Read public metadata through the
   issuer and require the exact application identity.
5. Set only GoWay's public `EXPO_PUBLIC_OXY_CLIENT_ID` repository variable when
   still absent, then read it back. A conflicting value stops the operation.
   Setting the variable does not deploy the consumer or grant user access.

`goway-rollback.sql` is a fail-closed operator template. Its arguments must come
from the successful creation receipt, including both xmin values and the sole
credential ID/public key. Under application→credential locks it compares identity,
owner, classification, authority and versions, then atomically revokes that
credential and suspends that application. It preserves history. Any mismatch or
extra credential aborts both writes. The public variable can be removed only if
it still equals this attempt's exact public key and was absent beforehand.
Rollback must also stop a future global seed from reactivating the spec; preserve
that operational hold until intentional reconciliation. No claim that suspension
retroactively revokes already issued user sessions is made. The exact template passed four real PostgreSQL controls on the fully migrated
Jest-owned database: success retaining both rows, stale credential, stale
application, and an unexpected additional credential. This is local evidence;
operational input values and the live execution still require root review.

## Nilo: existing identity, missing build input

Authenticated root inventory and public-only SQL found the existing application
`ed143b1b58d60eab417f7d5c` and exactly one active production public credential
`01a09dfd-1475-7e8d-a0cf-31f08fa9d966`, with no expiry. Metadata GET independently
confirmed that identity. The previously absent GitHub public variable
`EXPO_PUBLIC_OXY_CLIENT_ID` was set and read back; no other variable was changed.
Private receipt:
`/home/nate/Oxy/.agent-evidence/i04-consumer-rollout-preflight/nilo-public-client-configuration/receipt.json`.
Nilo source commit `195400b` forwards the variable into its existing web build.
No deployment was triggered, and no application, credential or grant was created.

## Local verification and setup failures

The registry/planner suites passed 66 tests; the exact rollback SQL passed four
controls. Scoped ESLint passed. PostgreSQL 17 used the agent-owned cluster at
127.0.0.1:5593; Jest created and dropped isolated migrated databases, readback
contained only standard databases and the cluster was stopped after each run.

Setup failures are preserved: an initial test invocation used the workspace root,
a subsequent package invocation lacked TEST_DATABASE_URL, and the first PG start
used a system socket directory without permission. The rollback fixture initially
omitted the required user color; the next run rejected a harmless pg_wrapper
warning instead of checking command status. Both fixture corrections are recorded;
these are not product RED regressions. Negative controls now require the exact
rollback refusal text, so process/setup failures cannot masquerade as denial.
