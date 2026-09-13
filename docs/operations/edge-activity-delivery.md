# Edge activity credentials

The `edge` lane of **Provision service credential** binds an existing application
ID to the reviewed destinations in `.github/config/edge-activity-targets.json`.
It issues an isolated `Edge activity (production)` principal with `user:read`.
The regular backend credential and its authority are unchanged.

Run with `dry_run=true` first. Cloudflare inventory uses organization Actions
secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; no token is recovered
from an existing deployment. Missing/parked targets are reported and skipped.
The workflow refuses delivery if no destination has a production deployment.
Nilo requires its exact-ID application seed before credential delivery. Schedio
has no verified application mapping and cannot be provisioned.

The encrypted existing handoff stores `OXY_EDGE_ACTIVITY_API_KEY` and
`OXY_EDGE_ACTIVITY_API_SECRET` in the application's exact SSM namespace. A
subsequent step reads that pair into memory and merges only three owned bindings
into Cloudflare: the pair and `OXY_EDGE_ACTIVITY_ENABLED`. None is a browser
build variable. Unknown IDs, failed inventory and incomplete pairs cannot write
Cloudflare secrets. Cloudflare response bodies are never logged.

`edge_activity_enabled` defaults to false. Set true only after verifying the
matching deployed `@oxy.so/telemetry/edge` adapter. Workers receive the entire
pair and flag in one bulk secrets merge patch. Pages updates only production
configuration; **a new production Pages deployment is required to use updated
bindings**. The workflow storing bindings does not claim that a Pages deployment
has been updated. Verify the production deployment and activity collector after
that app's normal deploy completes. Ordinary deploys must preserve these secret
bindings.

Validation: `node scripts/test-service-credential-workflow-ids.mjs` executes the
actual exact-ID/lane registry and the Python delivery regression suite; the
existing handoff and two-phase tests still cover encrypted credential recovery.
