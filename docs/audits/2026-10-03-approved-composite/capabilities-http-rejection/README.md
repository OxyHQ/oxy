# Capability approval-session HTTP rejection

CI37092451244/API2 failed Settings managed-account authorization: the new live-session read raised401 outside an Express4-managed async handler. The HTTP response stayed open after the10-second Jest failure; the shard eventually hit its15-minute cap. This was an HTTP error-handling bug, not permission to bypass the live-session check.

Only POST /capabilities/execution-authorizations now uses the existing asyncHandler. ApiError401 becomes a bounded JSON response; the authorization is not inserted. The Settings fixture now seeds a real live operated session and asserts the originating requester and managed owner on201. Missing/expired/inactive sessions return401 INVALID_SESSION without INSERT. Auth/operator, account access and coordinator boundaries remain explicitly synthetic; the second live-session lookup and authorization SQL are real PostgreSQL.

Frozen RED fixture8f2575461 and GREEN fixture are byte-identical. Three negative response timeouts trigger unhandled rejection reports across the Jest suite (7 failed total); after the single route wrapper delta all7 tests pass. The fixture owns an explicit HTTP server and closes connections normally; neither forceExit nor a timeout increase is used. An earlier intermediate token-literal duplicate was fixed before freezing the RED harness. API TypeScript and scoped ESLint pass. Both disposable PostgreSQL17 processes use normal migration139 and stop normally.

Reproduce from source root with `python3 scripts/rehearsal/test-approved-api-1519.py src/routes/__tests__/capabilitiesSettings.routes.test.ts`. Proof pins the route/helper/wrapper/runner and actual CI+RED/GREEN stdout. No production, provider or financial effects. Final CI and Forge revalidation remain separately tracked.
