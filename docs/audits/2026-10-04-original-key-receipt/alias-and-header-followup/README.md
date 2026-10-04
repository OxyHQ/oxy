# Original-key receipt isolation and OpenAPI followup

The original-key lookup now renders the exact metering row selected by credential, application, account, environment and delegation. Financial receipts additionally match the selected foreign key and the complete principal. A newer public generation alias cannot redirect recovery to another record. The existing public alias lookup is unchanged.

Four actual canonical HTTP/SQL cases cover both economic modes in both directions with a colliding alias, different credentials/environment and delegated versus undelegated attribution. The exact final fixture produces three failures and one control pass on `70b98e483`; all four pass after the correction. The combined API and generator suite passes 88 tests in five suites; all owned PostgreSQL processes were stopped.

The generated GET contract requires `Idempotency-Key` in a header, documents optional original `X-Oxy-User-Id` attribution, and publishes the real 400/404 error envelope. The exact header fixture produces two failures before generation and passes afterward. The 38 freshness guard cases, canonical regeneration/freshness, API typecheck and runtime lint pass.

The proof preserves the dependency-build setup failure, shared-fixture ordering failure, first missing schema-import generation failure and ignored-generator lint warning. They are not counted as product regressions. Final source and both exact frozen fixtures are hashed. The prior prose-only OpenAPI limitation is historical. No production or registry release is claimed.
