# Exact I03 live canary handoff

Prepared with read-only AWS calls on2026-10-04. No task registration, RunTask, credential, grant, IAM, application or production database mutation was executed by this preparation. Root is the sole production executor.

The unchanged reviewed external helper is in `/home/nate/Oxy/oxy/.worktrees/1519-i03-live-canary-20261003`, clean HEAD `2237ee282bddfde0c27a6c6ba5e9fc88b5d1d11b` (source4670c72c3+c63976419). Its API source matches final85dad exactly. Existing API58/compiledNode5, transport15, two-real-process12 and generatedNode6 evidence remains reusable; transport15 was repeated now and passed. This plan adds actual deployed metadata and pins, not a new implementation or live measurement claim.

## Bound inputs

Private operation directory: `/home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004`.

- `prepare-dispatch.json`: file SHA256 `5a2bc6ce263aae9c69f27c53ef79f07cbbf4c994eb31bfd706f4a432f06fc0f2`, canonical SHA256 `d5daa5b1d9e1cbfd2f7d347bedc23b589edde1350451421bc05fc487bdce81d8`. Preparation epoch1791083867, expiry1791085667; the helper rejects an expired dispatch. Regenerate and review a new exact plan if it expires; do not edit timestamps.
- `authorization-context.json`: SHA256 `1ef489841ed702c79fa750b7f16f79894e79b8e5250dd13f6a93531230c571ef`. Records the authorized task, scope, existing authority locator and evidence. It is a root-review context, not a fabricated human identity or independent approval. The launcher separately authenticates the actual AWS operator via STS.
- API `oxy-oxy-api:693`, image `sha256:b8d0d2f2325bf6d2a5a0df0f414185dfb940c48dc528cff794fa3820a3a2c534`, source85dad.
- Alia `oxy-alia:449`, image `sha256:18d5c54b4c0be5cbe14405683232d6a47f1a1011963c67f538c16acba9429895`, existing `oxy-alia-task` role; fresh stable count2 metadata checked. `verifier-readonly.json` binds this image and role.
- Five compiled hashes: `/home/nate/Oxy/.agent-evidence/root-1519-20261003/final-queue-85dad/i03-runtime-pins.json`; image-layer provenance alongside it. Root extracted them from the authenticated final image. The task checks each hash before importing API modules.

The existing Alia application/owner/grant principal are fixed in private context and canonical service. Historical inventory supplies only the principal locator. The prepare task takes current locked reads and refuses missing/revoked/drifted authority. It creates no credential. Nothing infers or adds user consent.

## Root execution sequence

Run from the clean helper worktree above. These commands are prepared; they have not been executed here.

```sh
python3 -B scripts/agency/alia-revocation-canary-ecs.py \
  --execute \
  --plan /home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004/prepare-dispatch.json \
  --output /home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004/prepare-run
```

Require exact task image, exit0, task STOPPED, own definition INACTIVE, one matching result/nonce and empty cleanup failures. Persist only the validated returned plan (no credential material) using the existing helper's exclusive0600/fsync writer:

```sh
python3 -B - <<'PY'
from pathlib import Path
import importlib.util, json
s = importlib.util.spec_from_file_location('canary', Path('scripts/agency/alia-revocation-canary-ecs.py'))
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
p = Path('/home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004')
dispatch = json.loads((p/'prepare-dispatch.json').read_text())
row = json.loads((p/'prepare-run/result.private.json').read_text())
cleanup = json.loads((p/'prepare-run/cleanup.json').read_text())
assert row['operation'] == 'prepare' and row['nonce'] == dispatch['nonce']
assert cleanup['operationComplete'] and not cleanup['failures']
m.canary_plan(row['result'], dispatch['operator'], True)
m.private_json(p/'canary-plan.json', row['result'])
PY

python3 -B scripts/agency/alia-revocation-canary-ecs.py \
  --operation execute --definition oxy-oxy-api:693 --verifier-definition oxy-alia:449 \
  --runtime-pins /home/nate/Oxy/.agent-evidence/root-1519-20261003/final-queue-85dad/i03-runtime-pins.json \
  --authorization-sha256 1ef489841ed702c79fa750b7f16f79894e79b8e5250dd13f6a93531230c571ef \
  --canary-plan /home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004/canary-plan.json \
  --plan /home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004/execute-dispatch.json
```

That second command only prepares the next private dispatch. Review its exact bytes/hash, runtime and current Alia binding, then root executes:

```sh
python3 -B scripts/agency/alia-revocation-canary-ecs.py \
  --execute --plan /home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004/execute-dispatch.json \
  --output /home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004/execute-run
```

One own service credential only: production environment, absolute expiry no more than one hour from canonical preparation, exact `acting-as:offline` and `inference:invoke` scopes. Secret and issued bearer remain memory/IPC only, never plan/env/disk/log. The token must have TTL≤300. Two independent actual core4.2 OxyServer processes prewarm read caches and each admit one loopback effect. They use the existing Alia workload verifier, distinct `wl_` credential on the same app. They are controlled canary receivers, not requests through the deployed Alia business handlers.

Success requires both samples measured from before canonical revoke to authoritative refusal below5000ms; SQL confirms the own credential revoked; each effect counter stays1; successful authenticated oracle denial distinguishes refusal from outage. Require `measured`, `success`, `cleanupConfirmed`, unchanged existing authority, no primary/cleanup failure, task STOPPED and own definition INACTIVE. This is a bounded live sample, not fleet p99 or a provider/business effect.

## Uncertain acknowledgement or failure

Never automatically repeat issuance/RunTask or create another credential. Keep original fsynced plan, dispatch intent, startedBy/clientToken and task identity. Missing list output is not proof of absence. Confirm the exact original task is STOPPED before any credential recovery.

```sh
python3 -B scripts/agency/alia-revocation-canary-ecs.py \
  --operation recover --definition oxy-oxy-api:693 \
  --runtime-pins /home/nate/Oxy/.agent-evidence/root-1519-20261003/final-queue-85dad/i03-runtime-pins.json \
  --authorization-sha256 1ef489841ed702c79fa750b7f16f79894e79b8e5250dd13f6a93531230c571ef \
  --canary-plan /home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004/canary-plan.json \
  --prior-plan /home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004/execute-dispatch.json \
  --prior-intent /home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004/execute-run/dispatch-intent.json \
  --plan /home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004/recovery-dispatch.json
```

Review then dispatch that recovery plan into a new private output directory. Recovery has no task role, only the same DB secret reference, exact creation audit/nonce/scopes/owner/expiry checks and canonical idempotent retirement. Expiry is not cleanup. API/Alia serving services, counts, scalers and deployment definitions remain untouched throughout.
