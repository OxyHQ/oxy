Issuer mint canary
==================

Run only after the reviewed issuer image is steady and every old issuer task has stopped. The bounded Node probe makes two legitimate mints245 seconds apart and verifies EdDSA/JWKS, attribution and exact300-second lifetime. It records statuses,429/retry headers and clock bounds without credentials, tokens or principal attributes. Mint updates existing authentication lastUsedAt and rate-limit counters; it invokes no product effects.

The ECS launcher inherits the pinned Noted37 image, network, execution role and log prefix. It removes the task role, DB, sidecars and all unrelated environment/secrets. Only the two existing Noted application references remain. Registered executable/authority shape and actual stopped-task digest are checked; cleanup independently confirms task STOPPED and task definition INACTIVE, including failure paths.

Prepare a fresh private plan using the exact new Oxy issuer ARN/digest:

```sh
python3 scripts/auth/run-service-token-issuer-canary-1519.py noted --issuer-definition "$ISSUER_TASK_DEFINITION_ARN" --issuer-image "$ISSUER_IMAGE_AT_DIGEST" --plan "$PRIVATE_PLAN"
```

After root reviews that plan, execute the same immutable inputs with `--execute --output "$NEW_PRIVATE_RESULT_DIRECTORY"`. A plan older than one hour or changed issuer task set/Noted shape/probe/launcher bytes fails closed. The fixture proof is local preparation; it does not establish live capacity,245-second renewal or rollout success.
