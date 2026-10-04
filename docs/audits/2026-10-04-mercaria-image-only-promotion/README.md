The image-only operator rolls Mercaria from the accepted TD61 without reconstructing its cohort or changing any flag, alias, role, sidecar, secret, count or service configuration. ROOT selects the new verified source and ECR image; this proof does not approve an image that has not been delivered yet.

Five offline methods cover exact rendering, rejected config/image drift, source-bound prepare/validate, real private intent files with unknown mutation acknowledgments, and cohort/target/readiness checks. The readiness test uses a loopback HTTP server. A separate render control uses the actual private TD61 definition in memory and persists only its hash and sanitized result. No AWS calls or production writes were made.

ROOT supplies a private JSON config with three hash-bound refs: `imageVerification`, `migrationVerification`, and `acceptedPrerequisites`. Each ref is `{ "path": "/absolute/path", "sha256": "64 hex characters" }`. The image protocol must name Mercaria and its exact new source/image and reviewed Dockerfile. The migration protocol is `root-consumer-migration-verification-v1`, with `service: "mercaria"`, matching `sourceSha`/`imageUri`, `mode: "not-required"`, and reviewed evidence refs establishing unchanged migration inputs. Existing accepted cohort prerequisites may be reused only after ROOT checks their applicability to the new source.

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/operations/mercaria-image-only-promotion.py prepare --config /private/config.json --output /private/fresh-plan.json
PYTHONDONTWRITEBYTECODE=1 python3 scripts/operations/mercaria-image-only-promotion.py execute --plan /private/fresh-plan.json --sha256 PLAN_FILE_SHA256 --output /private/new-attempt --execute
```

`prepare` performs read-only AWS checks; ROOT alone executes the second command after reviewing the fresh plan. The plan expires after 15 minutes. Registration and TD-only rolling update each have one durable intent and one mutation attempt. An unknown acknowledgment or failed serving gate preserves intent and requires ROOT reconciliation, without automatic mutation retries, count changes or old-image rollback.

Acceptance retains the original reviewed gates: sole completed deployment, all new task images, exact task-IP target binding, every task's exact cohort registration, and canonical `/health` plus `/health/ready` responses with no redirects or cookies. This is serving/configuration evidence and does not claim a paid transaction.
