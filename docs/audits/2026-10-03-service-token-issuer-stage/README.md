Issuer-only staging candidate

Source 62e009876 starts from main 4b145040, whose runtime Git inputs match the deployed c807c2b5 source tag. The ECR tag association is operational metadata, not a proof of the deployed filesystem. The only runtime change is the shared service JWT expiry constant from 3600 to 300 seconds. Both credential and workload issuance use that constant. Existing token verification, scope/grant handling, SDKs and migrations remain unchanged.

Frozen regression fixtures report two RED failures (3600 received), then 44/44 GREEN across the credential HTTP and workload SQL suites. Successful tokens are verified against the published ephemeral EdDSA key and assert exp−iat=300. The workload attestor and incidental route middleware are synthetic; binding, credential lookup and JWT signing/verification are real. The owned PostgreSQL harness scrubs inherited PG/URL overrides and validates PID/UID/executable/data directory/socket before creating an isolated database; the normal Jest migration setup runs. Both PostgreSQL processes stopped. API tsc and scoped ESLint exited zero.

Reproduce after `bun install --frozen-lockfile --minimum-release-age=0` and the dependency build recorded in dependency-build.log:

    python3 scripts/rehearsal/test-issuer-stage-1519.py src/routes/__tests__/serviceTokenCredentials.test.ts src/services/__tests__/workloadIdentity.db.test.ts

Promotion remains gated on an exact ARM image, authenticated provenance/Forge review with expiry fixed at 2026-10-09T22:00:00Z, and root's technical rollout review. No production action occurred. The stage introduces no new grants, DDL or provider effects.

After the new issuer revision is stable and all old issuer tasks are stopped, record the latest possible old mint time T. Drain for more than 3600 seconds, with a separately reviewed clock/transport safety margin, while observing actual 300-second mints and health. Do not start the strict final rollout until drain, live caller/receiver scope/grant preflight and final image review pass. Rolling back to the previous task/image restores 3600-second emission and resets T; restart the drain. This does not claim zero downtime or production revocation latency.
