# Quiesced deployment validation

Source `ba733f4fdf9e857d6a7ca5b5093afd57b45c16eb` adds the explicit manual/main cutover for an API already at zero, preserving the normal zero-capacity rejection. The 45 guard checks and 9 canonical shell checks cover readiness, migration/worker/API order, one TD/count restore, drift refusal and failure hold at zero. The existing normal deployment transaction suite and seven supporting checks pass. Exact commands, exit codes and source/record hashes are in [proof.json](proof.json).

These are local tests over mocked AWS responses, not a deployment rehearsal in production. The worker watcher and operational pause/restore plan remain separate gates. No old normal bootstrap is restored on maintenance failure.
