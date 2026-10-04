# Retire the previous ECS deployment before restoring admission

When a service is at zero, combining a new task definition and a positive count
in one ECS update can let the scheduler start the previous deployment. The
previous maintenance attempt exhibited this behavior; its failed outcome remains
historical. The frozen scheduler fixture reproduces that launch against main
85dad68e5 and rejects it after this change.

The maintenance path now installs the final definition at zero, verifies that
only its deployment remains and all prior tasks have stopped, then restores the
count in a separate update. It checks image/configuration, task ownership,
suspended scalers, empty target groups and the deployment identity before
admission. During rollout every living task must belong to that final deployment.
Normal rolling deployments retain their existing behavior.

Only an otherwise validated zero-count retirement can return a pending result.
Identity, configuration, scheduler or task drift fails immediately. A malformed
acknowledgment after the count restore also invokes the existing maintenance
shutdown path; it does not silently exit while the positive count remains.
Maintenance recovery holds the final definition at zero and never reinstalls the
old bootstrap image. Unknown write acknowledgments are not retried as writes.

Validation uses the actual shell with a bounded synthetic AWS CLI and the actual
guard with synthetic snapshots: 61 existing preflight/recovery checks, 45 final
deployment checks, 10 pending-versus-fatal controls, 11 shell checks and the frozen
cold-scheduler case. The malformed acknowledgment case first applies the positive
count and then verifies the explicit shutdown. Both new suites run in CI.
Biome with warnings treated as errors and shell syntax validation pass.

This source correction performs no AWS operation and does not claim another
production rollout or an ALB rollback. Existing Oxy API693/worker205 acceptance
remains separately recorded. Initial formatting diagnostics and the earlier
incorrect test filename were preparation failures; final commands are listed in
results.json. Earlier RED and intermediate logs are retained unchanged.
