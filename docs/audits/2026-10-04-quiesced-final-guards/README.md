The final current-main check and repeated retirement check now route any failure through the existing bounded maintenance shutdown handler. An unconfirmed shutdown remains a failure requiring ROOT reconciliation. The handler keeps the final definition at zero and never reinstalls the old task definition.

Quiesced rollout acceptance uses the admitted guard's latest validated observation after task, definition, configuration and scaler checks. Its closed public result reports steady only for the sole final PRIMARY/COMPLETED deployment, with service and deployment desired/running counts equal to the captured restore count and both pending counts zero. An IN_PROGRESS observation waits within the original deadline; identity/configuration failures still fail and hold. Ordinary rolling behavior is unchanged.

The byte-identical canonical shell fixture has five RED interleavings against source82 and five GREEN against the fix: final current-main rejection, final retirement/count drift, failed shutdown readback, stale outer COMPLETED followed by latest IN_PROGRESS, and eventual completion only after the validated latest observation. The 16 shell controls include the prior ordering/failed-rollout/old-task/ACK/normal-zero controls. Separate suites pass 61 preflight/recovery, 45 retirement/admission, 10 pending-vs-fatal and 12 latest-observation controls, the cold scheduler model, and the full ordinary deployment transaction shell suite. Biome1.9.4, shell syntax and diff checks pass.

All AWS responses are synthetic. No worker coordination or production execution is claimed. The initial local /tmp ENOSPC run is preserved alongside the successful owned-TMPDIR repeat. ROOT independent review and the combined Forge freeze remain separate acceptance steps.

```bash
TMPDIR=/home/nate/Oxy/.tmp/cas node scripts/test-quiesced-deploy.mjs
node scripts/test-quiesced-retirement.mjs
TMPDIR=/home/nate/Oxy/.tmp/cas node scripts/test-quiesced-cold-scheduler.mjs
TMPDIR=/home/nate/Oxy/.tmp/cas node scripts/test-quiesced-deploy-shell.mjs
TMPDIR=/home/nate/Oxy/.tmp/cas bash .github/scripts/test-deploy-ecs-image.sh
```
