# Existing external identity API log readback

`read-external-identity-api-logs.yml` reads existing CloudWatch events without
launching a task, fetching an actor, resolving an identity, or changing data.
It runs only from protected main with the original dispatching operator. Its
AWS session permits ECS descriptions/listing, ECR image readback, and reads of
the fixed `/oxy/ecs` API log streams.

Supply the currently deployed source SHA and immutable image digest, one exact
public Bird or Kilogram actor URI and matching transport account, and a UTC
window ending in the past. The window must be no longer than 15 minutes and
start within the last 24 hours. The workflow verifies the ECR source tag, live
container digest, settled service, and unchanged task set before publishing.
The workflow revision may be newer than the deployed image: it reads existing
logs and never executes application code from either revision.

```bash
gh workflow run read-external-identity-api-logs.yml -R OxyHQ/oxy --ref main \
  -f expected_source_sha="$OXY_DEPLOYED_SHA" \
  -f expected_image_digest="$OXY_DEPLOYED_DIGEST" \
  -f actor_uri="$PUBLIC_ACTOR_URI" \
  -f transport_acct="$PUBLIC_TRANSPORT_ACCT" \
  -f window_start="$READBACK_WINDOW_START" \
  -f window_end="$READBACK_WINDOW_END"
```

The artifact `identity-api-log-readback-<run ID>` contains `report.json` with
source/image selectors, task provenance, window bounds, and classified matching
events. It never retains raw logs, exception text, request headers, remote
response bodies, credentials, or complete task definitions. Typed failure
phases/reasons are allowlisted; unrecognized fields are discarded.

A complete read covers only the selected **currently live task streams**. It
cannot recover logs from tasks replaced before the readback. Zero matches are
inconclusive: older application code returns null silently for some failure
paths. This workflow does not prove successful identity resolution, cache
absence, or cold discovery. Preserve the original browser/protocol evidence
alongside this readback.

Offline controls:

```bash
python3 .github/scripts/test-read-external-identity-api-logs.py
```
