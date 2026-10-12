#!/usr/bin/env bash
# Boot the built oxy-api image the way ECS runs it, against a throwaway Postgres
# and Redis, and fail unless its runtime (Bun, PID 1, the image's own entrypoint
# and user) can:
#   1. run as Bun 1.4.3 — and run Bun when a command still says `node` (a
#      worker revision registered before the switch, or a stale override);
#   2. apply the migrations, then run the deploy's exact pre and post migrator
#      commands to exit 0, and reject an unknown --phase;
#   3. exit NON-zero when the API cannot boot (a missing secret), rather than
#      hang or exit 0 — Bun and Node differ on unhandled rejections and exit
#      codes, and ECS reads only the code;
#   4. serve /health with 200, database and Redis connected, from the image's
#      default CMD with Bun as PID 1;
#   5. produce OpenTelemetry spans (http + express) through the API's own
#      telemetry setup, flushed on shutdown;
#   6. boot the asset-variant worker and stop it cleanly on SIGTERM;
#   7. turn SIGTERM (`docker stop`, as ECS does on a rollout) into the graceful
#      shutdown and exit 0.
# A unit suite cannot see any of these: they are properties of the image.
set -euo pipefail

: "${IMAGE:?IMAGE required}"
: "${DATABASE_URL:?DATABASE_URL required (a throwaway, empty database)}"
: "${REDIS_URL:?REDIS_URL required (a throwaway Redis)}"
PORT="${PORT:-8080}"
OTLP_PORT="${OTLP_PORT:-4318}"
API="oxy-api-smoke-$$"
WORKER="oxy-asset-worker-smoke-$$"
work="$(mktemp -d)"
receiver_pid=""

cleanup() {
  docker rm -f "$API" "$WORKER" >/dev/null 2>&1 || true
  [[ -n "$receiver_pid" ]] && kill "$receiver_pid" 2>/dev/null || true
  rm -rf -- "$work"
}
trap cleanup EXIT

fail() {
  echo "::error::$*"
  exit 1
}

# Throwaway secrets: generated here, valid for this run only.
SERVICE_TOKEN_PRIVATE_KEY="$(openssl genpkey -algorithm ed25519 | base64 | tr -d '\n')"
export SERVICE_TOKEN_PRIVATE_KEY
# One token per variable, so step 3 can drop one cleanly.
common_env=(
  --env=DATABASE_URL --env=REDIS_URL "--env=QUEUE_REDIS_URL=$REDIS_URL"
  --env=NODE_ENV=production "--env=PORT=$PORT"
  --env=ACCESS_TOKEN_SECRET=ci-smoke-access-secret-0123456789abcdef0123456789abcdef
  --env=REFRESH_TOKEN_SECRET=ci-smoke-refresh-secret-0123456789abcdef0123456789abcde
  --env=DEVICE_ID_SALT=ci-smoke-device-salt-0123456789abcdef0123456789abcdef0123
  --env=SERVICE_TOKEN_PRIVATE_KEY --env=SERVICE_TOKEN_SIGNING_KEY_ID=ci-smoke
  --env=AWS_REGION=us-west-2 --env=AWS_S3_BUCKET=ci-smoke-throwaway --env=AWS_EC2_METADATA_DISABLED=true
)

# ── 1. Runtime ───────────────────────────────────────────────────────────────
bun_version="$(docker run --rm "$IMAGE" bun --version)"
[[ "$bun_version" == "1.4.3" ]] || fail "image runs bun '$bun_version', expected 1.4.3"
node_runs="$(docker run --rm "$IMAGE" node -e 'process.stdout.write(String(process.versions.bun))')"
[[ "$node_runs" == "1.4.3" ]] ||
  fail "\`node\` in the image is not Bun 1.4.3 (got '$node_runs'); a revision still naming node would break"

# ── 2. Migrator ──────────────────────────────────────────────────────────────
if docker run --rm --network host "$IMAGE" bun packages/api/dist/db/migrate.js --phase=nonsense \
  >"$work/nonsense.log" 2>&1; then
  fail "the migrator accepted --phase=nonsense"
fi
grep -q 'Unrecognised --phase' "$work/nonsense.log" || fail "the migrator did not reject --phase=nonsense by name"
# A fresh database needs `all`: `pre` refuses by design to apply a pre-deploy
# migration queued behind an unapplied post-deploy one.
docker run --rm --network host --env=DATABASE_URL "$IMAGE" \
  bun packages/api/dist/db/migrate.js --phase=all
# The commands deploy-ecs-image.sh and deploy-aws.yml run, verbatim.
for phase in pre post; do
  docker run --rm --network host --env=DATABASE_URL "$IMAGE" \
    bun packages/api/dist/db/migrate.js "--phase=$phase"
done

# ── 3. A boot that cannot succeed must exit non-zero ────────────────────────
broken_env=()
for value in "${common_env[@]}"; do
  [[ "$value" == --env=ACCESS_TOKEN_SECRET=* ]] || broken_env+=("$value")
done
broken_exit=0
timeout 90 docker run --rm --network host "${broken_env[@]}" "$IMAGE" >"$work/broken.log" 2>&1 ||
  broken_exit=$?
if [[ "$broken_exit" == 0 || "$broken_exit" == 124 ]]; then
  cat "$work/broken.log"
  fail "the API without ACCESS_TOKEN_SECRET exited $broken_exit; a failed boot must exit non-zero, promptly"
fi
grep -q 'ACCESS_TOKEN_SECRET' "$work/broken.log" || fail "the failed boot did not name the missing secret"

# ── 4. Boot, PID 1, readiness ───────────────────────────────────────────────
cat >"$work/otlp-receiver.mjs" <<'RECEIVER'
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const [port, out] = process.argv.slice(2);
createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    appendFileSync(out, `${JSON.stringify({ path: req.url, body: Buffer.concat(chunks).toString('base64') })}\n`);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
}).listen(Number(port), '127.0.0.1');
RECEIVER
bun "$work/otlp-receiver.mjs" "$OTLP_PORT" "$work/otlp.jsonl" &
receiver_pid=$!

docker run -d --name "$API" --network host "${common_env[@]}" \
  "--env=OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:$OTLP_PORT" --env=OTEL_TRACES_SAMPLER=always_on \
  --env=OTEL_METRICS_EXPORTER=none --env=OTEL_SERVICE_NAME=oxy-api-smoke \
  "$IMAGE" >/dev/null

health=""
for _ in $(seq 1 90); do
  if health="$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null)"; then break; fi
  health=""
  [[ "$(docker inspect -f '{{.State.Running}}' "$API")" == true ]] || break
  sleep 1
done
if [[ -z "$health" ]]; then
  docker logs "$API" || true
  fail "the API image never answered /health"
fi
jq -e '.database == "connected" and .redis == "connected"' <<<"$health" >/dev/null ||
  fail "/health answered without both stores connected: $health"

pid1="$(docker exec "$API" cat /proc/1/cmdline | tr '\0' ' ')"
case "$pid1" in
  "bun packages/api/dist/server.js "*) ;;
  *) fail "PID 1 is '$pid1', expected 'bun packages/api/dist/server.js'" ;;
esac

for path in /health / /users/me; do
  curl -s -o /dev/null "http://127.0.0.1:$PORT$path"
done

# ── 6. The asset-variant worker ─────────────────────────────────────────────
docker run -d --name "$WORKER" --network host "${common_env[@]}" "$IMAGE" \
  bun packages/api/dist/asset-variant-worker.js >/dev/null
worker_up=""
for _ in $(seq 1 60); do
  if docker logs "$WORKER" 2>&1 | grep -q 'asset-variant worker is running'; then worker_up=1; break; fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$WORKER")" == true ]] || break
  sleep 1
done
if [[ -z "$worker_up" ]]; then
  docker logs "$WORKER" || true
  fail "the asset-variant worker never reported running"
fi
docker stop -t 35 "$WORKER" >/dev/null
worker_exit="$(docker inspect -f '{{.State.ExitCode}}' "$WORKER")"
if [[ "$worker_exit" != 0 ]] || ! docker logs "$WORKER" 2>&1 | grep -q 'asset-variant worker stopped'; then
  docker logs "$WORKER" || true
  fail "the asset-variant worker did not stop cleanly on SIGTERM (exit $worker_exit)"
fi

# ── 7. Graceful SIGTERM ─────────────────────────────────────────────────────
docker stop -t 35 "$API" >/dev/null
api_exit="$(docker inspect -f '{{.State.ExitCode}}' "$API")"
logs="$(docker logs "$API" 2>&1)"
if [[ "$api_exit" != 0 ]] || ! grep -q 'All connections closed, exiting' <<<"$logs"; then
  printf '%s\n' "$logs"
  fail "SIGTERM did not end in a graceful exit 0 (exit code $api_exit)"
fi

# ── 5. Spans, flushed by the shutdown above ─────────────────────────────────
sleep 1
[[ -s "$work/otlp.jsonl" ]] || fail "the API exported no OpenTelemetry payload"
scopes="$(jq -r 'select(.path == "/v1/traces") | .body' "$work/otlp.jsonl" | while read -r body; do
  base64 -d <<<"$body" | jq -r '.resourceSpans[].scopeSpans[] | .scope.name as $s | .spans[] | "\($s) \(.name)"'
done | sort | uniq -c)"
printf 'Spans exported:\n%s\n' "$scopes"
grep -q '@opentelemetry/instrumentation-http GET /health' <<<"$scopes" ||
  fail "no http server span for GET /health"
grep -q '@opentelemetry/instrumentation-express request handler - /health' <<<"$scopes" ||
  fail "no express span for the /health handler"

echo "API image smoke passed: Bun 1.4.3 (and \`node\` is Bun), migrator phases, failed boot exits $broken_exit, /health 200 with Postgres + Redis, PID 1 = Bun, http + express spans, worker start/stop, graceful SIGTERM exit 0"
