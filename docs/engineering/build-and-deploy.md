# Build, packaging and deployment

> Moved out of `AGENTS.md` unchanged. The one-line rules stay there.

## AWS Deployment

The backend (`oxy-api`) runs on **AWS ECS Fargate** (region `us-west-2`, cluster `oxy-cluster`), behind an ALB with ACM HTTPS.

- **Port**: `8080` | **Domain**: `api.oxy.so` (the oxy.so/fairco.in website API is the separate `website-api` service at `website-api.oxy.so`; outbound email via SES, inbound via Cloudflare Email Routing → Worker `email-inbound` → `POST /email/inbound`)
- **Deploy**: the merge queue builds the `linux/arm64` image in parallel with CI (`.github/workflows/merge-queue-image.yml` → ECR `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api:mq-<sha>`); on the push to main `.github/workflows/deploy-aws.yml` reuses that exact image by digest (`.github/scripts/resolve-queue-image.sh`, which falls back to building it) → tags it `deployed-<sha>` → rolls it out on ECS
- **Auth**: GitHub OIDC → role `oxy-github-deploy`. No AWS keys stored in GitHub.
- **Secrets**: SSM Parameter Store is the ONLY source (`/oxy/oxy-api/*`, SecureString; shared ones in `/oxy/_shared/*`, owned by oxy-infra); ECS injects them into the container at task start. The deploy workflow writes no parameter and reads no repo secret — `scripts/check-deploy-secrets-sync.mjs` fails CI otherwise. To change a secret: `aws ssm put-parameter --type SecureString --overwrite --name /oxy/oxy-api/<NAME>`, then roll out (oxy-infra `docs/runbooks/46-app-secrets-in-ssm.md`). A NEW secret is written to SSM FIRST and bound in the task definition second. Until 2026-10-10 GitHub repo secrets were copied into SSM on every deploy; that path is gone, and editing a GitHub secret changes nothing in production.
- **No placeholders**: never write a placeholder value (`-`, empty, `TODO`) to an SSM parameter a task binds. A `REDIS_URL=-` placeholder once crash-looped `oxy-api` with `getaddrinfo ENOTFOUND -` from `ioredis` (commit `641cea67`). If you don't have the real value yet, don't create the parameter yet.
- **SSM path convention**: per-app secrets → `/oxy/<app>/<KEY>`; shared infra (`REDIS_URL`, `AWS_*`, `LIVEKIT_*`) → `/oxy/_shared/<KEY>`. ECS task definitions reference these paths directly.
- **Dockerfile**: must build for `linux/arm64` (Graviton).
- **WARNING**: Never put secret values in this file.

## Inbound Email Path (Cloudflare → Worker → API)

Inbound mail for `*@oxy.so` is delivered as follows:

1. **MX** records for `oxy.so` point at Cloudflare Email Routing (`route1/2/3.mx.cloudflare.net`).
2. Cloudflare Email Routing has a **catch-all rule → Worker `email-inbound`** (source: `workers/email-inbound/`, zone `oxy.so` = `7f70358609578c4a1f24dbf6cb9c4498`).
3. The Worker POSTs the raw RFC 5322 message to `${API_URL}/email/inbound` with `Authorization: Bearer ${EMAIL_INBOUND_WEBHOOK_SECRET}` and `X-Envelope-From` / `X-Envelope-To` headers.
4. The API route `packages/api/src/routes/emailInbound.ts` (mounted at `/email/inbound` BEFORE `/email`, with a raw body parser registered in `server.ts:95`) parses MIME, validates recipients, spam-checks, and stores into Postgres via `emailService.storeIncomingMessage`.
5. Inbox UI at `inbox.oxy.so` reads `GET /email/mailboxes` + `GET /email/messages`.

**Critical config invariants** — if any drifts, inbound mail silently disappears:
- Worker var `API_URL` MUST equal `https://api.oxy.so` (`mail.oxy.so` is a retired hostname, not an API route).
- Worker secret `EMAIL_INBOUND_WEBHOOK_SECRET` MUST equal SSM `/oxy/oxy-api/EMAIL_INBOUND_WEBHOOK_SECRET` (mismatch → API returns 401 → Cloudflare bounces).
- The raw body parser at `server.ts:95` MUST be registered BEFORE the global `express.json()` middleware (otherwise the JSON parser eats the RFC822 stream and `simpleParser` gets an empty Buffer).
- `app.use('/email/inbound', emailInboundRoutes)` MUST be registered BEFORE `app.use('/email', ...)` in `server.ts` (otherwise the protected `/email` mount catches the unauthenticated webhook first).

**Worker deploy (when bindings drift):**
```bash
cd workers/email-inbound
export CLOUDFLARE_API_TOKEN=$(cat ~/.config/oxy/cloudflare.token)
export CLOUDFLARE_ACCOUNT_ID=$(aws --profile oxy --region us-west-2 ssm get-parameter --name /oxy/oxy-api/CLOUDFLARE_ACCOUNT_ID --with-decryption --query 'Parameter.Value' --output text)
./node_modules/.bin/wrangler deploy
aws --profile oxy --region us-west-2 ssm get-parameter --name /oxy/oxy-api/EMAIL_INBOUND_WEBHOOK_SECRET --with-decryption --query 'Parameter.Value' --output text \
  | ./node_modules/.bin/wrangler secret put EMAIL_INBOUND_WEBHOOK_SECRET
```

**Verify health:**
```bash
# 1. Confirm Worker bindings
curl -s -H "Authorization: Bearer $(cat ~/.config/oxy/cloudflare.token)" \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/email-inbound/settings" \
  | jq '.result.bindings'   # API_URL must be https://api.oxy.so

# 2. Confirm endpoint mounted (expect 401 = good, 404 = route gone, 500 = secret missing)
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.oxy.so/email/inbound

# 3. CloudWatch (log group is /oxy/ecs, NOT /ecs/oxy-api)
aws --profile oxy --region us-west-2 logs tail /oxy/ecs --log-stream-name-prefix oxy-api --since 1h \
  | grep -iE 'inbound|envelope|delivered'
```

**Current mail state:**
- SPF for `oxy.so` now reads `v=spf1 include:amazonses.com include:_spf.mx.cloudflare.net ~all`.
- The legacy `mail.oxy.so` A record is absent.
- Worker `email-inbound` redeployed with `API_URL=https://api.oxy.so` (ECS).
- Outbound: SES via `SMTP_RELAY_HOST` only. nodemailer v8 removed the legacy `{ direct: true }` MX path — `smtp.outbound.ts` now fails fast if `SMTP_RELAY_HOST` is unset.

## Containers (oxy-api Docker / ECS one-shot tasks)

### Runtime: Bun

The oxy-api image runs on Bun 1.4.3: the `Dockerfile` runtime stage is the
digest-pinned `oven/bun:1.4.3-alpine` (musl, like the stages that install the
production dependencies, so Sharp's binding matches), the CMD is
`bun packages/api/dist/server.js`, and every ECS command names `bun` — the
migrator in `deploy-ecs-image.sh`, `deploy-aws.yml`, `deploy-quiesced-image.sh`
and `run-postgres-migrations.yml`, and the Kaana canary/readback workflows. The
image has no Node; its `node` is a symlink to bun, so a stale `node ...`
command still runs Bun. `deploy-asset-variant-worker.sh` accepts a running worker
revision naming either and always renders the new one as `bun ...` (the ECS
service ignores terraform's task-definition changes, so the deploy is what
moves the running worker). CI's
`API Image (Bun runtime smoke)` job builds the image (amd64: the PostGIS
service image is amd64-only; the merge queue builds arm64) and runs
`.github/scripts/smoke-api-image.sh`. Outbound `fetch` goes through
`tracedFetch` (`scripts/check-api-raw-fetch.mjs`): Bun's `fetch` is invisible
to the undici instrumentation. Returning to Node is reverting the change that
switched the runtime stage and the commands together.

### Asset-variant producer and worker

Asset rendition generation has two runtime roles built from the same image:

- `bun packages/api/dist/server.js` runs the HTTP API and only produces jobs
  on the BullMQ `asset-variants` queue.
- `bun packages/api/dist/asset-variant-worker.js` consumes that queue with
  concurrency 1 and performs the sharp/ffmpeg work. The package shortcut is
  `bun run --filter @oxy.so/api start:asset-variant-worker`.

The worker command requires `DATABASE_URL`, `QUEUE_REDIS_URL` and
`AWS_S3_BUCKET`. It also reads `AWS_REGION` (`us-east-1` default) and optional
`AWS_ENDPOINT_URL`. `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` are optional for
both roles: set together they are used as static keys (local dev); unset, the
SDK's default provider chain resolves the ECS task role, which is how
production runs. Production API startup
fails when Redis is absent, and the worker fails when any required value is
absent; neither condition may silently move transcoding back into an HTTP
process. Development without Redis retains a single-file-at-a-time in-process
fallback so local uploads remain usable.

Deploy the worker as an independently scalable ECS service with no load
balancer. API tasks and worker tasks have separate CPU target-tracking policies;
the worker remains at one task when idle and can grow to four under sustained
sharp/ffmpeg load. API replica count must never determine transcoding
concurrency.

Migration phases cross release boundaries explicitly. Every deployment runs
the candidate's additive `pre` entries before rollout and its `post` entries
only after the new image reaches a healthy steady state. Never replace those
two runs with `--phase=all`: that would apply candidate-only destructive changes
while the previous image still serves.

The `oxy-api` Dockerfile uses Bun 1.3's **isolated linker** (default). Dependencies do NOT live at `/app/node_modules/<pkg>` — they live at:

```
/app/node_modules/.bun/<pkg>@<version>+<hash>/node_modules/<pkg>
```

This breaks naive `require('<pkg>')` from a `node -e` one-liner inside the container. To resolve, either:

- Run via a script file that lives inside the package's own resolution graph (where Node's normal resolution works), OR
- Use an **absolute path** to the isolated location.

**Cleaning Redis from a dev laptop**: the Valkey/Redis security group only accepts traffic from ECS task security groups, so you cannot connect from a laptop. Instead, run a one-shot Fargate task that overrides the container `command` to execute an inline cleanup. Example:

```bash
aws --profile oxy --region us-west-2 ecs run-task \
  --cluster oxy-cluster --task-definition oxy-oxy-api --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-08f5cc132b3cab15c,subnet-0bfb367f29d1fd375],securityGroups=[sg-0f0ca416eacab578c],assignPublicIp=ENABLED}' \
  --overrides '{"containerOverrides":[{"name":"oxy-api","command":["sh","-c","node -e \"const Redis=require('"'"'/app/node_modules/.bun/ioredis@5.11.1+f89edaf472774726/node_modules/ioredis'"'"');/* ... */\""]}]}'
```

Look up the exact `.bun/<pkg>@<ver>+<hash>/` directory in the running image (it changes on every install) before invoking. The full path is required because the inline `-e` script is not inside any package's resolution graph.

**GOTCHA — oxy-api Dockerfile: do NOT switch to a full-workspace frozen-lockfile install (PR #261):** The Dockerfile intentionally installs only the lean `core+contracts+api` workspace subset (workspaces-narrowing `node -e` + `bun install`). A full-workspace `bun install --frozen-lockfile` pulls `esbuild` (a frontend-only dep) whose arm64/alpine postinstall hard-fails with `Expected "0.27.2" but got "0.25.12"`, breaking the prod Docker build. A proper fix requires a SCOPED frozen install (`--filter` the api/core/contracts closure so `esbuild` is never materialized) or a single-esbuild-version root override, validated on a real arm64 build. Do NOT apply a naive full-workspace frozen install to the API Dockerfile.

## Native Android releases

One reusable workflow, `.github/workflows/android-release.yml` in this repo, releases every Oxy Android app. Each app repo calls it on push to its default branch:

```yaml
# <app repo>/.github/workflows/android-release.yml
name: Android release
on:
  push:
    branches: [main]
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  release:
    permissions:
      contents: write
    uses: OxyHQ/oxy/.github/workflows/android-release.yml@main
    with:
      app-dir: packages/frontend
```

- **A new binary is a new `version`.** The run reads the app config; if `<tag-prefix>-v<version>` is already a GitHub release it ends there, because the change ships as an OTA update under the same runtime (`withOxyUpdates`, `appVersion` policy). Otherwise it prebuilds and runs `:app:bundleRelease`, then `:app:assembleRelease` in a second Gradle invocation, archives the AAB and the APKs on seldon (`$OXY_RELEASE_ARCHIVE/<owner>/<repo>/<tag>/`, with `SHA256SUMS`; the app's three newest versions are kept), uploads the AAB to Google Play's **internal testing** track, and publishes the GitHub release (prerelease) with only the APKs and their `.sha256` files — the AAB is never public. A `workflow_dispatch` of a released version fails: bump the version.
- **Google Play.** Seldon holds the `play-publisher@oxy-play.iam.gserviceaccount.com` service-account key (`GOOGLE_PLAY_SERVICE_ACCOUNT_FILE`, mode 600); the step mints its own token (no third-party action). Google has no API to create an app, and an app has no package until its first bundle is uploaded in Play Console: for a package Play does not know, the run warns with the archived AAB's path; upload it there once (Internal testing), roll that release out, and every later version uploads itself. A versionCode Play already holds is not re-uploaded, so a re-run after a partial failure is safe. While Play will not send an app's changes for review on its own (an app still in setup, or with managed publishing), it refuses a plain commit; the step commits again with `changesNotSentForReview=true` and warns, and the release waits for "Send for review" in Play Console. Play App Signing must use the ecosystem key as the app signing key ("use my own key"), or installs from Play carry another certificate and Commons refuses them.
- **One APK per ABI, never a universal APK.** `@oxy.so/app-preset` 6.1.1 `withOxyAbiSplits` (applied by the preset and by `withOxyUpdates`) turns on Gradle's ABI splits, so `assembleRelease` writes `app-arm64-v8a-release.apk` and `app-armeabi-v7a-release.apk`; the release names them `<package>-<version>-<abi>.apk`. A universal APK carried every ABI's native libraries and a phone loads one (Mention: 126 MB, of which 55 MB arm64-v8a and 37 MB armeabi-v7a libraries). The release notes say which to pick: arm64-v8a for phones from about 2017 on, armeabi-v7a for older phones and Android TVs. A build with no split APK, or without both of those ABIs, fails ("needs @oxy.so/app-preset >= 6.1.1"); there is no universal fallback. The splits are off in an invocation that builds a bundle: with R8 resource shrinking, AGP fails `buildReleasePreBundle` ("Multiple shrunk-resources files found … disable building multiple APKs when building an Android app bundle", [issuetracker 402800800](https://issuetracker.google.com/402800800)), so the AAB and the APKs are always two `./gradlew` runs; asking for both in one gives a universal APK, which the release refuses. Both APKs carry the app's one versionCode: Android installs either over the other, and Play's unique-versionCode-per-APK rule only applies to APKs uploaded to Play, which gets the AAB (splits do not touch `bundleRelease`).
- **Every native release checks the iOS keychain access groups.** Before the Android prebuild, a release of an app with an `ios.bundleIdentifier` runs an iOS `expo prebuild` of the same commit and `oxy-check-keychain-entitlements <bundle id> ios` (`@oxy.so/app-preset` >= 6.4.0, or the release fails) over the entitlements it wrote: exactly the bundle id's layout, optionally followed by the app's own `$(AppIdentifierPrefix)<bundle id>` ([ios-keychain-access-groups.md](../identity/ios-keychain-access-groups.md#who-may-list-which-group)).
- **Every iOS archive is checked as signed, before upload.** iOS builds are made by hand in Xcode (no workflow builds one), so on the Mac that archived it run `bunx oxy-check-keychain-entitlements <bundle id> <path to .xcarchive or .ipa>` (`@oxy.so/app-preset` >= 6.5.0) from the app's directory. It reads the entitlements `codesign` reports for the app and every embedded extension, each under the id and team its own signature names, and fails (exit 1) on any group the policy does not give that bundle id; do not upload a build it refuses. Security review R6-15: the prebuild check cannot see what a manual Xcode change, a capability toggled in the portal or an extension target adds.
- **The build number is derived, never kept** — `@oxy.so/app-preset` 6 `withOxyReleaseVersion` (1.2.3 → 1002003), applied by the preset and by `withOxyUpdates`.
- **The build env is the eas.json profile's `env`** (`eas-profile`, default `production`, following `extends`) plus `NODE_ENV=production`; no other configuration.
- **Only the default branch is released.** The runner group checks this workflow's ref, not the caller's, so the first step fails any run whose `github.ref` is not the caller's default branch: a `workflow_dispatch` from a feature branch would otherwise sign that branch's code with the ecosystem key and take its version's tag.
- **It runs only on `seldon`**, the self-hosted build machine (Ryzen 9 9950X, 60 GB RAM, Debian 13, user `gha` without sudo). Its org runner group `seldon` is restricted to `OxyHQ/oxy/.github/workflows/android-release.yml@refs/heads/main`: no other workflow and no pull request of any public repo can run a job there. It holds the ecosystem keystore in `/home/gha/.oxy/` (mode 600) and passes it as `ORG_GRADLE_PROJECT_OXY_UPLOAD_*` from the runner's `/opt/actions-runner/.env`, so no signing material is on GitHub; `oxyVerifyReleaseSigning` still fails any release without the ecosystem certificate. The Android SDK is `/opt/android-sdk`; Gradle's user home keeps its caches between runs, with `org.gradle.jvmargs=-Xmx16g -XX:MaxMetaspaceSize=4g` (Expo's 2 GB default runs out of Metaspace building React Native from source). Hermes from source needs `libicu-dev`.
- A repo with several apps (Willo's frame, Mercaria's POS) calls it once per app with a distinct `tag-prefix`.
- **This repo's own apps** release through `android-release-apps.yml` (`accounts-android-v…`, `commons-android-v…`), called by path so the job's workflow ref is still `…/android-release.yml@refs/heads/main`; it runs only when an `app.config.js` (where `version` lives) changes, or by `workflow_dispatch`. In a Turbo repo the reusable workflow builds the app's workspace dependencies (`turbo run build --filter='{./<app-dir>}^...'`) before prebuilding, because Metro resolves `@oxy.so/core`, `contracts`, `protocol` and `expo-splash` from `dist/`. Their OTA updates publish from `publish-update.yml` (one matrix job per app, each with its own public client id, running `packages/ship` from source); that exact path is the two apps' trusted publisher.
- **Android releases wait for Seldon.** The keystore and the Play key exist only there, so while Seldon is down a release job stays queued (GitHub keeps it up to 24 hours) and runs when Seldon is back. Nothing falls back to hosted for a release, on purpose.

## CI on Seldon

The org is on GitHub's free plan: 20 hosted jobs at once across every repository. Seldon also runs a pool of ephemeral CI VMs, `seldon-ci`, which relieves that queue. How the host side runs, installs and is rebuilt (pool, image, cache, cleanup) is OxyHQ/oxy-infra `docs/runbooks/69-seldon-ci-pool.md`; its files are versioned in oxy-infra `seldon/`.

**The pool.**
- **What it is.** Runner group `seldon-ci` (id 6), label `seldon-ci`. Just-in-time runners, each in its own Incus KVM VM, run exactly one job and are deleted.
- **Size.** 4 VMs of 4 vCPU and 10 GiB since 2026-11-26, the same core count as hosted (jobs size their parallelism from it). At 6 vCPU / 7 GiB, Bloom's `bun run typescript` ran out of heap and Jest shards starved; at 8 vCPU / 12 GiB, Bloom's language parity started 7 Jest workers and was OOM-killed at 11.9 GB. Plus 6 light VMs (2 vCPU / 3 GiB, label `seldon-ci-light`) for lint, small builds and checks that peak around 1.5 GB; a job that runs a full `tsc` stays on `seldon-ci` (the image sets `--max-old-space-size=4096`). The race treats every label that starts with `seldon-ci` as a Seldon lane.
- **Image.** `ci-base` has the toolchain hosted runners have or Oxy's workflows pin: Node 24.21.0 and 24.20.0 in the tool cache, gh, rustup (stable, nightly, 1.99.0), OpenJDK 17 and 21, bun and docker. A job installs nothing, so do not add install steps to workflows; add the tool to the image.
- **Cache.** npm, bun and cargo go through a caching proxy on the host, and lockfile integrity still verifies every byte.
- **Workspace.** `/home/runner/work/<repo>/<repo>`, the same path as hosted. So an Actions cache entry of a path outside the workspace (`~/.bun`, `~/.cargo`, `~/.gradle`) restores to the same place on both. While the workspace sat one level deeper, setup-bun's cache restored to the wrong place ("Unable to locate executable file: /home/runner/.bun/bin/bun").

**Isolation**, verified 2026-11-26 by a probe job (OxyHQ/Bloom runs 45756779277 and 45756878441). A pool job runs as `runner` in a VM, never as `gha`, and sees none of the release material:
- no `/home/gha` (keystore), no `/srv/oxy-releases`, and no `/opt/actions-runner*` (`.env`, credentials, work directories);
- no release variables;
- only the internet and the host's DNS and cache, on a private bridge. The LAN and the host's other ports are unreachable.

The group is not restricted to workflows, so no secret may ever be put in the image.

**Who reaches it.** Only a repository's own code. A fork's pull request always runs hosted: the workflows route only `push`, `merge_group`, `workflow_dispatch`, `schedule` and same-repository `pull_request` runs to the pool, and the org's fork-PR approval (`all_external_contributors`) still gates every fork run.

**Routing: the race (every repository in [Wiring a repo](#wiring-a-repo), each with the repository variable `CI_SELDON_RACE=true`).** GitHub cannot let a job say "Seldon or hosted", and it has no API that cancels a single job. A job whose label has no online runner waits up to 24 hours instead of failing. So a heavy job races, using only `GITHUB_TOKEN` (`.github/actions/seldon-race` and its reusable workflows in this repo):
1. The job targets `seldon-ci`. A hosted twin with the same name and steps (YAML anchors) waits.
2. A hosted start job watches the run. If a Seldon lane is still unstarted after the delay, because the pool is busy or offline, the twin queues too.
3. Each lane's first step is a guard. A lane that starts after its twin sleeps until it is cancelled, so the work never runs twice.
4. A hosted finish job polls until every pair has a started lane. The lane that started first wins (a tie goes to Seldon). A reap job then queues into each loser's job-level `concurrency` group (`seldon-race-<run>-<attempt>-<lane>-<name>`, `cancel-in-progress`), which cancels that one job. The reap jobs run on `seldon-ci-light`: the cancellation happens when a reaper is queued, so its runner does not matter, and no hosted slot is spent on it. While Seldon is down a reaper waits, which leaves the run `in_progress` until Seldon is back; the losers are cancelled anyway, and `CI complete` must not need the finish job.
5. A Seldon lane that fails, for whatever reason, gets a rescue: a hosted job `X-rescue` with the same name and steps (and no guard), which needs `X` and runs only when `X` failed. The house's ISP (Vodafone DS-Lite) drops new connections in bursts, so a Seldon lane can fail its checkout, an upload or a service pull where hosted passes; a genuine failure fails again in the rescue.
6. `CI complete` takes each raced job's verdict from the jobs API whenever `CI_SELDON_RACE` is on: per job name, "a lane passed and no hosted lane failed". A cancelled loser is never a failure, a failed Seldon lane is excused by its twin's or its rescue's success, and a failed hosted lane never is. The gate judges `X`, `X-hosted` and `X-rescue` on that verdict when the race ran or the rescue ran, and otherwise judges `X` alone and requires the other two skipped. Required checks and the merge queue still see one result. A rescued run concludes `failure` (one of its jobs failed), so anything that trusts a run trusts its `CI complete`, not its conclusion.
   - **Control jobs.** The verdict never judges the race's own jobs: start, finish, the reapers and retry. They are marked by name, starting `Seldon race ` (and the older `Reap seldon-race-`), whatever runner they use.
   - **Re-runs.** The verdict reads every attempt (`filter=all`) and judges each job name on the most recent attempt that ran it. A name the re-run didn't touch keeps its winner and cancelled loser together; a name it re-ran is judged on that attempt alone. A gate re-run, a "Re-run failed jobs" and the hosted retry (`seldon-race-retry.yml`, which is one such re-run, hosted, because lanes use Seldon only on attempt 1) are therefore all judged the same way.

When raced jobs come in waves (a raced job that needs another), each wave gets its own start and finish with the `names` input, the display names it covers. Without it, the first wave's finish would wait for twins of the second wave's lanes that its race never queued, and the second wave's start would see the first wave's finished lanes and call no race.

Seldon being down therefore costs the delay, never the run, and with the variable unset nothing changes. The decision itself runs on hosted runners, so it never depends on Seldon.

**What stays hosted:**
- jobs that need another OS or arm;
- releases: npm trusted publishing with provenance needs a GitHub-hosted runner, and the tarballs it attests are built in the same hosted workflow;
- light jobs (lint, provenance, scope, `CI complete`), where a hosted slot is short.

**Runner Apps.** GitHub Apps that register runners for the org:

| App | Permission | Used by | State |
| --- | --- | --- | --- |
| `oxy-seldon-ci` (id 5624160, created 2026-11-05) | organization self-hosted runners: write | `oxy-ci-pool.service` on Seldon mints JIT runners for group `seldon-ci`; its key is `/etc/oxy-ci/github-app.pem` on Seldon | in use |
| `oxy-home-runners` (id 5355333, created 2026-10-17) | organization self-hosted runners: write | the ThinkPad home-runner pilot, dropped 2026-10-19 | unused: no online runner was registered with it, and nothing on Seldon holds its key. Safe to uninstall. |

Seldon's release runners `seldon`, `seldon-2` and `seldon-3` were registered once with a registration token (2026-11-04) and use no App. The repo-level `seldon-oxyos-*` runners serve OxyHQ/OxyOS's gate. Never give a workflow a runner App's key: runners: write can register a runner into any group, `seldon` included.

**The network.** Since 2026-11-05 the house's connections fail for one to fifteen minutes at a time, for every destination at once (Google, GitHub, Cloudflare). The rejection is `ICMP admin prohibited` from 192.0.0.1, upstream of the double NAT, and it is worse on heavy-build days. Evidence and the probe are in runbook 69. A pool job that hits a burst fails the way a flaky network does; its rescue reruns it hosted, and the retry caller re-runs a failed first attempt hosted.

### Wiring a repo

Every repository that races calls the same action and reusable workflows from this repo, at `@main` (a repository that requires SHA pins pins the action; see below). Templates that merged: OxyHQ/Gemies#175 and #176 (a new `CI complete`, two waves, rescues), OxyHQ/website#262 and #263, OxyHQ/Bloom#981, OxyHQ/Mention#2052 and OxyHQ/oxy#2330.

**Worth wiring.** A repository races when at least one Linux x64 pull-request job usually runs a minute or more. Below that, the hosted start job and the gate cost more hosted slots than the lane saves; for a private repository, every job is also billed as at least a minute.

**Where each job goes.**
- `seldon-ci` (4 vCPU / 10 GiB): any job that runs a full `tsc` or typecheck, a large test suite, a large image build, a Rust build, or needs more than about 1.5 GB.
- `seldon-ci-light` (2 vCPU / 3 GiB): a job under about 1.5 GB with no full `tsc`, such as a bundle or a small build.
- Hosted: lint, change detection, provenance, the race's start job and `CI complete`, where a hosted slot is short. arm, macOS and Windows jobs. Jobs that need a tool the image lacks (no Android SDK, no Xcode), and anything that publishes.

**Steps.**
1. Read the repository's rulesets, or its classic branch protection when it has none (`gh api repos/OxyHQ/<repo>/rulesets`, then each one's `required_status_checks`). Keep a copy of the JSON.
2. Open one pull request with:
   - a `CI complete` gate, if the repository has none;
   - a lane, a twin and a rescue for each heavy job, and light routing;
   - one start and one finish per wave of raced jobs;
   - the retry caller: a copy of OxyHQ/Bloom's `.github/workflows/seldon-race-retry.yml` with `workflows:` set to the CI workflow's `name:`;
   - a fix for anything that reads a raced run's conclusion (below).
3. When the required checks are only `CI complete`, or none: `gh variable set CI_SELDON_RACE -R OxyHQ/<repo> --body true` before the pull request runs. Prove the race with that run: a heavy job passed on a `seldon-ci` runner (not just a reaper on `seldon-ci-light`) and `CI complete` passed. When the pool is busy the hosted twins win; that shows the race works, not that Seldon does, so prove it again on a later pull request. Then merge it.
4. When the required checks name individual jobs: get the pull request green hosted, with the variable unset, and leave it open. The required checks are switched to `CI complete` first; then the wiring merges, the variable is set, and the next pull request proves the race. A required job name cannot follow the race: the twin and the rescue share the name, and a cancelled loser reports under it.

**The snippet.** One raced job `build` (display name `Build`) in one wave. Further raced jobs reuse `*seldon-lane`, `*race-lane-permissions` and `*race-guard`.

```yaml
jobs:
  race:
    if: ${{ !cancelled() && vars.CI_SELDON_RACE == 'true' && github.run_attempt == 1 && (github.event_name == 'pull_request' || github.event_name == 'merge_group') && !github.event.pull_request.head.repo.fork }}
    uses: OxyHQ/oxy/.github/workflows/seldon-race-start.yml@main
    permissions:
      actions: read
    with:
      names: |
        Build

  race-finish:
    needs: race
    # `!cancelled()`: a skipped ancestor must not skip it.
    if: ${{ !cancelled() && needs.race.outputs.race == 'true' }}
    uses: OxyHQ/oxy/.github/workflows/seldon-race-finish.yml@main
    permissions:
      actions: read
    with:
      names: |
        Build

  build:
    name: Build
    runs-on: &seldon-lane ${{ vars.CI_SELDON_RACE == 'true' && github.run_attempt == 1 && (github.event_name == 'pull_request' || github.event_name == 'merge_group') && !github.event.pull_request.head.repo.fork && 'seldon-ci' || 'ubuntu-latest' }}
    concurrency:
      group: seldon-race-${{ github.run_id }}-${{ github.run_attempt }}-seldon-Build
    permissions: &race-lane-permissions
      contents: read
      actions: read # the guard reads this run's jobs
    timeout-minutes: 20
    steps: &build-steps
      # A lane that starts after its twin waits here to be cancelled.
      - &race-guard
        name: Seldon race guard
        if: vars.CI_SELDON_RACE == 'true' && !endsWith(github.job, '-rescue')
        uses: OxyHQ/oxy/.github/actions/seldon-race@main
        with:
          mode: guard
      - uses: actions/checkout@v7
      - run: bun install --frozen-lockfile && bun run build

  # The hosted twin: the same name (while the race is on), services, strategy and steps.
  build-hosted:
    name: ${{ vars.CI_SELDON_RACE == 'true' && 'Build' || 'Build (seldon twin, off)' }}
    needs: race
    if: ${{ !cancelled() && needs.race.outputs.race == 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency:
      group: seldon-race-${{ github.run_id }}-${{ github.run_attempt }}-hosted-Build
    permissions: *race-lane-permissions
    steps: *build-steps

  # The rescue: reruns the job hosted when its Seldon lane failed.
  build-rescue:
    name: ${{ vars.CI_SELDON_RACE == 'true' && 'Build' || 'Build (seldon rescue, off)' }}
    needs: build
    if: ${{ !cancelled() && needs.build.result == 'failure' && vars.CI_SELDON_RACE == 'true' && github.run_attempt == 1 && (github.event_name == 'pull_request' || github.event_name == 'merge_group') && !github.event.pull_request.head.repo.fork }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions: *race-lane-permissions
    steps: *build-steps

  ci-complete:
    name: CI complete
    if: always()
    # Not race-finish: its reapers run on seldon-ci-light.
    needs: [race, build, build-hosted, build-rescue]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      actions: read # the verdict reads this run's jobs
    steps:
      - name: Seldon race verdict
        id: race
        if: vars.CI_SELDON_RACE == 'true'
        uses: OxyHQ/oxy/.github/actions/seldon-race@main
        with:
          mode: verdict
      - name: Every job passed
        env:
          RESULTS: ${{ toJSON(needs) }}
          RACE_VERDICT: ${{ steps.race.outputs.outcome }}
        run: |
          set -euo pipefail
          failures=()
          result() { jq -r --arg job "$1" '.[$job].result // "missing"' <<<"$RESULTS"; }
          r="$(result race)"
          case "$r" in success | skipped) ;; *) failures+=("race did not pass: $r") ;; esac
          # The verdict when the race or the rescue ran; otherwise the job's
          # own result, with its twin skipped.
          family() {
            local job="$1" wave="$2" own twin rescue raced
            own="$(result "$job")"; twin="$(result "$job-hosted")"; rescue="$(result "$job-rescue")"
            raced="$(jq -r --arg w "$wave" '.[$w].outputs.race // ""' <<<"$RESULTS")"
            if [ "$rescue" != skipped ] || { [ "$raced" = true ] && ! { [ "$own" = skipped ] && [ "$twin" = skipped ]; }; }; then
              family="${RACE_VERDICT:-no verdict}"; return
            fi
            [ "$twin" = skipped ] || failures+=("$job-hosted ran although the race did not: $twin")
            family="$own"
          }
          family build race
          [ "$family" = success ] || failures+=("build did not pass: $family")
          if [ ${#failures[@]} -gt 0 ]; then printf '::error::%s\n' "${failures[@]}"; exit 1; fi
```

A second wave (a raced job that needs another raced job) gets `race-2` and `race-2-finish` with its own `names`, and `race-2` needs the first wave's three jobs and runs when any of them passed. Every job that needs a raced job `X` needs `[X, X-hosted, X-rescue]` and accepts success from any of the three; a matrix job's twin and rescue keep its `strategy`, and its concurrency group includes the matrix display name.

**A repository that requires SHA pins** (`sha_pinning_required` in its Actions policy, OxyHQ/tnp for one) refuses an action at `@main`, inside a workflow it calls too. It does not refuse a reusable-workflow ref by branch: a tnp probe called `seldon-race-start.yml` by branch name and passed (tnp run 45908673941). So:
- the race's reusable workflows call the action at a full SHA, marked `# main`. When the action changes on main, `seldon-race-pin.yml` opens an issue with the exact command that moves those pins (`.github/scripts/pin-seldon-race.mjs`). It cannot open the pull request itself, because GitHub refuses a `GITHUB_TOKEN` push that changes `.github/workflows/`;
- such a repository pins its own guard and verdict steps the same way (`uses: OxyHQ/oxy/.github/actions/seldon-race@<sha> # main`), and may call the reusable workflows `@main`.

**Rules learned the hard way.**
- While `CI_SELDON_RACE` is unset, a twin or a rescue does not share its job's display name: `X (seldon twin, off)` and `X (seldon rescue, off)`, built with `format()` for a matrix name. A skipped one would otherwise be the newest check run of that name and could mask a failed required check. With the variable set the names match, which the race needs, since it pairs lanes by display name. GitHub does not evaluate a skipped job's name, so a skipped twin shows the expression itself in the checks list; it still differs from `X`, which is what matters.
- The required checks are switched to `CI complete` before the wiring merges, never after.
- Every twin, rescue and finish job runs under `!cancelled()`. Without a status function, a skipped ancestor skips it.
- No gate waits on a finish job: its reapers run on `seldon-ci-light`, so needing it would wait on Seldon.
- The race runs on `pull_request` and `merge_group` only, never on `push` or `workflow_dispatch`. Deploys that trust a push run stay unchanged.
- Anything that reads a run's conclusion (a deploy, queue provenance, a release check) accepts a `cancelled` or `failure` run whose `CI complete` passed: a reaped loser makes the run `cancelled`, a rescued lane makes it `failure`. See OxyHQ/Bloom, OxyHQ/Mention and OxyHQ/website `merge-queue-verified.sh`, and `release-package.mjs` here.
- A check that judges a job name from the jobs API passes the name when one of its jobs succeeded and none failed, never by whichever job of that name the API lists last: that can be a skipped twin or rescue (OxyHQ/Mercaria `require-ci-success.mjs`, #1258).
- Jobs that run a full `tsc` or typecheck stay on `seldon-ci`. Only jobs under about 1.5 GB with no full `tsc` go to `seldon-ci-light`.
- arm, macOS and Windows jobs stay hosted.
- A step that re-resolves the lockfile (`bun install --lockfile-only`, a lockfile-sync check) sets `BUN_CONFIG_REGISTRY=https://registry.npmjs.org/`. The image points bun at the host's cache, and a re-resolve on Seldon writes the cache's URLs into `bun.lock`, so the check fails there and passes hosted (OxyHQ/Homiio run 45903677170).
- Lanes go to Seldon on `run_attempt` 1 only, so a re-run, and the retry caller's re-run, is hosted.
- A test with a tight timeout (bun's default 5 s) can trip on Seldon while the pool is full and cost a rescue: OxyHQ/Syra run 45903866884 (a test at 7.6 s) and OxyHQ/Peable run 45924894369 (a `beforeEach` hook). Give a test that does real work an explicit timeout.
- Uploads from a raced job use `overwrite: true`, so a rescue replaces what its failed lane uploaded and a merge step reads whichever lane won.
- A repository that checks job-level `concurrency` (Gemies' `check-workflow-concurrency.mjs`) learns the lanes' groups: unique to the run, no `cancel-in-progress`.

**Wired repositories.** The ruleset is the one on `main`; the proof run is a pull-request or queue run in which a heavy job passed on a `seldon-ci` runner and the gate passed.

| Repository | Pull request | Ruleset (required checks) | `CI_SELDON_RACE` | Proof run |
| --- | --- | --- | --- | --- |
| OxyHQ/Bloom | #981, #1013 | 24486145 (`CI complete`) | on | 45906280655 |
| OxyHQ/oxy | #2330, #2337, #2338 | 24004899 (`CI complete`) | on | 45904419882 |
| OxyHQ/Mention | #2052, #2054 | 24154319 (`CI complete`) | on | 45908926689 |
| OxyHQ/Gemies | #175, #176, #180 | 27102831 (`CI complete`) | on | 45910924235 |
| OxyHQ/website | #262, #263, #264 | 24486392 (`CI complete`) | on | 45904450111 |
| OxyHQ/Homiio | #852, #854 | classic protection (`CI complete`) | on | 45905599854 |
| OxyHQ/Inbox | #277, #279 | 24913174 (`CI complete`) | on | 45923523037 |
| OxyHQ/Mercaria | #1258, #1259 | classic protection (`CI complete`) | on | 45907441667 |
| OxyHQ/Allo | #333, #334 | classic protection (`CI complete`) | on | 45905820020 |
| OxyHQ/Kaana | #343, #344 | classic protection (`CI complete`) | on | 45903882616 |
| OxyHQ/OxyOS | #631 | 24913180 (`Native foundation complete`, `apps-tests`, `scenarios`) | on | 45907614898 (merge queue) |
| OxyHQ/Nilo | #231 | 24913178 (`CI complete`) | on | 45924905092 |
| OxyHQ/Clarity | #259, #260 | 24913171 (`CI complete`) | on | 45903917133 |
| OxyHQ/Authenticator | #93, #94 | 24913169 (`CI complete`) | on | 45904218326 |
| OxyHQ/Move | #86 | 24913177 (`CI complete`) | on | 45902328064 |
| OxyHQ/Noted | #328, #329 | 24913179 (`CI complete`) | on | 45905949845 |
| OxyHQ/CrowdSource | #359 | 24913172 (`CI complete`) | on | 45944430533 |
| OxyHQ/Schedio | #113, #114 | 24913181 (`CI complete`) | on | 45903644109 |
| OxyHQ/Vibbr | #18 (open: auto-merge is off) | none | on | 45904270967 |
| OxyHQ/Moovo | #225, #226 | 24913176 (`CI complete`) | on | raced, hosted won (45915581017) |
| OxyHQ/Syra | #316, #317 | classic protection (`CI complete`) | on | Seldon lane rescued (45903866884) |
| OxyHQ/Peable | #311, #313 | classic protection (`CI complete`) | on | Seldon lane rescued (45924894369) |
| OxyHQ/GoWay | #328 (open: main fails `oxy-doctor`) | classic protection (`CI complete`) | on | raced (45904730546) |
| OxyHQ/tnp | #164 (open: waits for the switch and a code-owner review) | 24913182 (five job names) | off | none yet |

"Raced, hosted won" and "rescued" are runs in which the race and the gate worked but no heavy job passed on Seldon, because the pool was full or a timing-sensitive test tripped there. Each still needs a run in which Seldon wins.

**Not wired.**
- Every pull-request job usually runs under a minute: OxyHQ/Alia (48 s at most), Atlas (about 30 s), Dropsea (29 to 48 s), Codea (about 25 s), Willo (8 to 31 s), examples, BloomAiIcons and willo-local (under 25 s), and oxy-infra (private; 8 to 16 s jobs, each billed as a minute).
- OxyHQ/activity-wallpaper: its one job is an Android build, and the image has no Android SDK.
- OxyHQ/react-native and OxyHQ/maplibre-react-native: forks of upstream projects, with upstream's CI.
- The repositories with no pull-request CI: Astro, Studio, OxyPaySDK, engineering, mercaria-woocommerce and `.github`.

## Commands

```bash
bun run core:build               # Build @oxy.so/core
bun run services:build           # Build @oxy.so/services
bun run build:all                # Build all (order: contracts -> core -> services -> rest)
bun run test                     # Run all workspace tests (Jest via turbo — see note below)
bun run dev                      # Dev mode across workspaces
bun install                      # Install all workspace deps
```

**Shared dependency versions live in `workspaces.catalog` (root `package.json`), not in the manifests.** A package shared by two or more workspaces is declared there once and referenced as `"catalog:"` everywhere it is used, root `overrides` included — an override reading `"catalog:"` still rewrites transitive resolutions. Bumping one is a single edit plus `bun install`. A package with a range that legitimately differs per workspace (`packages/core` and `packages/protocol` target Expo SDK 56 while the apps are on 58) stays literal, because a catalog entry would be asserting an agreement that does not exist.

This is safe for PUBLISHED packages only because the release packs with bun and `release-package.mjs inspect` refuses a tarball that still carries the literal: `bun pm pack` substitutes a `catalog:` reference to the catalog's own range, while `npm pack` ships the literal string `catalog:`, which no consumer can resolve — the exact failure that broke `@oxy.so/core@12.10.1` with `workspace:`, one protocol later. Verified on the real `@oxy.so/core` and `@oxy.so/services` tarballs.

**`bun install` refuses to RESOLVE a dependency published in the last week** (`minimumReleaseAge` in `bunfig.toml`), where a compromised release is most likely to still be live. Resolution only — a frozen install is never affected, cold cache included. Anything that re-resolves must opt out, which is why `scripts/check-lockfile-sync.mjs` passes `--minimum-release-age=0`; without it a dependency published this week fails that check for a week with nothing actually wrong. The quarantine is for third-party packages: every first-party package is exempt, so publishing one and bumping its consumer in the same session needs no override. Excludes match EXACT names (a `"@oxy.so/*"` glob parses and silently matches nothing), so `minimumReleaseAgeExcludes` names every published first-party package, the same list in every Oxy repo with the quarantine (oxy, Bloom, BloomAiIcons, Inbox). `scripts/check-release-age-excludes.mjs` (CI) fails if `bun.lock` resolves a first-party package the list misses, or if the list names a glob or a package outside the first-party scopes (`@oxy.so`, `@alia.onl`, `@alia-codea`, `@clarity.surf`, `@crowdsource.you`, `@fairco.in`, `@gemies`, `@goway.to`, `@kaana.ai`, `@mercaria.co`, `@peable.to`, `@syra.fm`, `@vibbr.co`, and `create-oxy-app`). A newly published first-party package goes in the list in each of those repos.

**Test runners — per-package split (CRITICAL):**
- `@oxy.so/api`, `@oxy.so/core`, `@oxy.so/services`, `@oxy.so/contracts`, and the `commons` app use **Jest** (ts-jest / jest-expo). Their `test` script invokes `jest`.
- `packages/auth` (the standalone Vite IdP app) uses **Bun's native `bun test`** — configured via `packages/auth/bunfig.toml` (`[test] preload`), NOT jest. Its `test` script is `bun test lib/__tests__ components/__tests__` (the earlier `server/__tests__` suite no longer exists — do not reference it).
- `packages/ship` and `packages/node` also use `bun test` (`bun test src`). `packages/node` runs on Bun in production (its store is `bun:sqlite`, which only Bun provides), so its suite cannot run under jest; its tests import the BUILT `dist/` of contracts, protocol and core, which CI builds first.
- THE RULE: always run each package's OWN `bun run test` script, which dispatches to the correct runner. At the monorepo root, `bun run test` delegates through turbo and is safe. NEVER blanket-invoke `bun test` across the monorepo — it runs Bun's native runner over the Jest packages, producing dozens of false failures in core and api (`jest.resetModules`, `jest.advanceTimersByTimeAsync`, and other Jest APIs are unavailable under Bun's runner). Do NOT assume all packages are Jest — the auth app (`packages/auth`) is bun-test.
- Per-package baselines, as last verified 2026-07-19 (when run under the correct runner): contracts **147**, core **1052**, api **1808**, services **305**, auth IdP **59**, commons **411**. These drift as suites grow — re-verify with each package's own `bun run test` rather than trusting a number here that's gone stale.

**CI: pull requests run what they reach; the queue runs everything.** `scripts/ci-scope.mjs` decides, per pull request, which scoped suites (`api`: API shards + API Build; `platform`; `apps`) the change can reach — each suite's packages are read from its jobs' own steps in `ci.yml`, closed over workspace dependencies and the lockfile. `guards` always runs; `merge_group` always runs everything and `CI complete` refuses any skip there. A test that reads the WHOLE repo (not its package closure) must be listed in `REPO_WIDE_TESTS` and also run from `guards`; the scope's census test goes red otherwise.

**CI: the Turbo build cache is read-only in `ci.yml`.** Workspace builds run through `turbo run build` after `actions/cache/restore` of `.turbo/cache`; the only writer is `.github/workflows/ci-build-cache.yml` on push to `main` (fresh build, no restore). Only `build` is cacheable (every other task in `turbo.json` is `cache: false`), `build.inputs` is `$TURBO_DEFAULT$` plus core's shared build scripts, and `bun.lock`, the root `package.json`, `bunfig.toml` and `tsconfig.json` are global inputs. `scripts/check-ci-build-cache.mjs` (run in `guards`) enforces all of it. Not cached on purpose: `~/.bun/install/cache` — cold it is ~4.2 GB / 233k files (~1.4 GB compressed) against a 12-25 s network install, and the repo's 10 GB Actions cache is already full with the deploy's BuildKit layers. Locally, Turbo shares one cache across git worktrees (the main checkout's `.turbo/cache`); set `TURBO_CACHE_DIR` when experimenting.

## Architecture

Monorepo (`@oxy.so/sdk`) using Bun workspaces + Turbo. Build order matters: `contracts` -> `core` -> `services` -> rest (turbo derives this from the dependency graph). **`@oxy.so/services` is the single UI SDK for web AND native** (RN Web on web) — the former standalone web SDK package was deleted from the monorepo; do not recreate it.

```
packages/
  contracts/      @oxy.so/contracts  Contract-first API schemas (Zod) — zero React/RN/Expo
  protocol/       @oxy.so/protocol   Shared protocol layer
  core/           @oxy.so/core       Platform-agnostic foundation (zero React/RN)
  services/       @oxy.so/services   Expo/React Native SDK — the ONLY UI SDK (web via RN Web + native)
  api/            @oxy.so/api        Express.js backend API
  node/           @oxy.so/node       User-operated data node (signed-records replica)
  federation/     @oxy.so/federation App-agnostic ActivityPub identity + follow engine substrate (connector contract, HTTP signatures, bridge relabelling — see "Federation" below)
  accounts/                         Expo accounts app ("Accounts by Oxy" — keyless, management-only)
  commons/                          Expo identity vault app ("Commons by Oxy" — NATIVE-ONLY, no web build)
  auth/                             Vite IdP app (auth.oxy.so — OAuth authorize/consent on @oxy.so/services, device-first like every app)
  console/                          Developer portal (Vite + @oxy.so/services)
  test-app-expo/                    Expo test/playground app
  expo-splash/    @oxy.so/expo-splash
  app-preset/     @oxy.so/app-preset Shared Expo config plugin + Metro/Babel/CSS/ESLint/tsconfig bases for every Oxy app
  create-oxy-app/ create-oxy-app    `bun create oxy-app` scaffolder — generates the canonical packages/frontend+backend+shared-types monorepo
  ship/           @oxy.so/ship       oxy-ship CLI — publishes Expo OTA updates to the Oxy Updates service
```

**Dependency graph:**
```
@oxy.so/contracts      no internal deps (only zod)
@oxy.so/core           dep: @oxy.so/contracts
@oxy.so/services       dep: @oxy.so/core + @oxy.so/contracts
@oxy.so/api            dep: @oxy.so/contracts + @oxy.so/core/server for auth middleware
@oxy.so/federation     dep: @oxy.so/core (isomorphic entry has zero Express/database deps; `./node` subpath adds them)
accounts              dep: @oxy.so/core + @oxy.so/services
commons               dep: @oxy.so/core + @oxy.so/services  (NATIVE-ONLY — no web build/CF Pages)
console               dep: @oxy.so/core + @oxy.so/services  (RN Web via Vite)
auth (IdP)            dep: @oxy.so/core + @oxy.so/services  (RN Web via Vite, device-first cold boot)
test-app-expo         dep: @oxy.so/services
```

**Expo native-module version alignment (accounts, commons, test-app-expo):** when `@oxy.so/services`' pinned version of a native module (e.g. `react-native-svg`, `react-native-safe-area-context`, `react-native-keyboard-controller`) diverges from the version the current Expo SDK bundles, align the whole monorepo UP to the higher version and add that package to `expo.install.exclude` in the app's `package.json` — this stops `expo install --fix` / expo-doctor from downgrading it back to the SDK-bundled version. Never let two versions of the same native module coexist across the workspace. `react-native-svg`, `react-native-safe-area-context`, `react-native-gesture-handler`, `react-native-worklets` and `react` are excluded in every Expo app (accounts, commons, console, test-app-expo), `react-dom` wherever the app declares it; `react-native-keyboard-controller` is additionally excluded in accounts, commons and console (test-app-expo doesn't depend on it).

**Noxcturnal stays off (accounts, commons, console):** Noxcturnal, Expo's oxc transformer (`experiments.noxcturnalTransformWorker`), stays off: noxcturnal 0.1.11 to 0.1.13 miscompile `@tanstack/query-core`'s `QueriesObserver` on web (the temporary holding the lowered constructor's return value reuses `_result`, the name of the `#result` private key), so every `useQueries` throws "attempted to use private field on non-instance" in development. Development and production both bundle with Babel; turn it back on only with a release that compiles that class correctly. Each app's `babel.config.js` is the one line `require('@oxy.so/app-preset/babel')` (bare in development, the build-id inliner in production); `@/` resolves from `tsconfig.json` paths and Jest's `moduleNameMapper`. `react-native-css` is catalogued and overridden to Bloom's exact version, so the tree never holds a second copy. The Expo CLI is the sealed fork in `vendor/expo-native`; it pins `@expo/metro-config` exactly, so moving `expo` forward means rebuilding the fork (`scripts/build-native-expo-forks.mjs`) on the CLI version that `expo` declares.

## @oxy.so/contracts — Contract-First API Schemas

Package: `packages/contracts` → `@oxy.so/contracts`. SINGLE SOURCE OF TRUTH for API request/response contracts.

**What it contains:**
- Zod schemas: `userNameSchema` (`displayName` field is optional — `z.string().optional()`), `userResponseSchema` (includes `did?` + `verifiedDomains?`), `userProfileUpdateSchema`, `currentUserResponseSchema`, `deviceSessionAccountSchema`, `deviceSessionsResponseSchema`
- **Device-first schemas (`src/deviceBoot.ts`, wave 2):** `deviceBootReasonSchema`, `deviceBootFragmentSchema`, `deviceExchangeRequestSchema`, `tokenRefreshRequestSchema`, `tokenRefreshResponseSchema`, `deviceTokenIssueResponseSchema`, `loginResultSchema` + inferred types `DeviceBootReason`, `DeviceBootFragment`, `DeviceTokenIssueResponse`, `LoginResult`/`LoginSessionResult`/`LoginTwoFactorRequired`. The legacy multi-account refresh schemas/types (`refreshAllAccountSchema`, `refreshAllResponseSchema`) AND the IdP `deviceResolve*` chooser schemas/types (`deviceResolveRequestSchema`, `deviceResolveResponseSchema`, `DeviceResolveRequest`, `DeviceResolveAccount`, `DeviceResolveResponse`) were REMOVED — do not reference them; the IdP now enumerates the device directory via the device-first SDK (`useDeviceSwitcher`), not a cookie/resolve feed.
- **Identity schemas (`src/identity.ts`):** `didDocumentSchema` (+ `verificationMethodSchema`, `didServiceSchema`), `signedRecordEnvelopeSchema`, `verifiedDomainSchema` + domain-request/instructions schemas, `authMethodsResponseSchema` (extended with `did` + per-method `verificationMethodId`), `exportBundleSchema`
- Helpers: `resolveUserId`, `safeParseContract`
- Inferred types: `UserNameResponse` (explicit `interface`; `displayName` is **`string | undefined`** — optional; prior to being made explicit it degraded to `{}` under `moduleResolution: node`), `UserResponse`, `UserProfileUpdate`, `CurrentUserResponseContract`, `DeviceSessionAccountResponse`, `DeviceSessionsResponseContract`; identity types: `DidDocument`, `VerificationMethod`, `DidService`, `SignedRecordEnvelope`, `VerifiedDomain`, `AuthMethodsResponse`, `ExportBundle`
- **`src/civic.ts`** — civic/Oxy ID schemas: `publicCardSchema`, `idPayloadSchema`, `attestQrPayloadSchema`, `validationVoteSchema`, `personhoodSchema`, `credentialSchema` + inferred types. Consumed as `workspace:*` by `packages/api`, `packages/core`, and `packages/services`. **NOT yet published to npm** — keep as internal `workspace:*` until Fases 0–4 are fully deployed and stable.

**Build:** dual CJS+ESM+types via tsc (same pattern as core: `tsconfig.{cjs,esm,types}.json` + `scripts/fix-esm-imports.mjs`). Zero runtime deps except `zod`.

**Dockerfile:** both builder and production stages MUST include `packages/contracts`: COPY the directory, build it before core/api, copy its `dist` into the production stage. Any future workspace package consumed by oxy-api MUST be added to the Dockerfile the same way or `bun install` in the ECS image fails to resolve `workspace:*`.

**Rule:** new shared API contracts go in `@oxy.so/contracts`. Server validates output against them; clients validate input and derive `z.infer<>` types. This prevents the Zod-drift class of bug (field-shape mismatch causing `safeParse` to silently return null and the auth app to show logged-out state). Do NOT re-introduce local schema copies in `packages/auth/lib/schemas.ts` — use `@oxy.so/contracts` directly or keep schemas strictly in sync.

**CI / test build-order — resolve workspace deps from source (CRITICAL):**
`.github/workflows/ci.yml` job `api-test` runs `bun install` then `bun run test` in `packages/api` — it does NOT build workspace deps first. `@oxy.so/contracts` and `@oxy.so/core` ship compiled, so tests importing them fail in CI with `Cannot find module` unless mapped to source. Fixed by resolving both from their TypeScript source in test configs:
- **api (Jest):** `moduleNameMapper` in `packages/api/jest.config.js` → `'^@oxy.so/contracts$': '<rootDir>/../contracts/src/index.ts'` and `'^@oxy.so/core/server$': '<rootDir>/../core/src/server/index.ts'` (the latter added because `@oxy.so/api` now imports `safeFetch`/`SsrfRejection` from `@oxy.so/core/server` for federation and email SSRF fixes — PRs #259/#264/#266).
- **auth (bun test):** `mock.module('@oxy.so/contracts', …)` in `packages/auth/lib/__tests__/setup-contracts-source.ts`, loaded first via `packages/auth/lib/__tests__/preload.ts` (mirrors the existing `mock.module` pattern in `lib/__tests__/setup-mocks.ts` for `@oxy.so/bloom/avatar`).

RULE: any package whose tests import a build-required workspace dep (`@oxy.so/contracts`, `@oxy.so/core/server`, etc.) MUST either map that dep to `src/` in the test config (Jest `moduleNameMapper` or bun-test `mock.module` preload) OR the CI job must build the dep first. The contracts source uses extensionless relative imports (`from './userResponse'`), which work under both ts-jest and bun's resolver.

**api BUILD now pre-builds `@oxy.so/core` (source change):** `packages/api/package.json` build script pre-builds its workspace dependencies (`@oxy.so/core` among them) through `node ../core/scripts/build-workspace-deps.mjs … && tsc`. That helper builds them in order when the package is built on its own, and does nothing under `turbo run build`, where the `^build` edge already built them — running those nested builds concurrently there made `build:all` fail at random (one build deleting telemetry's `dist/` while another type-checked against it). core, federation and node pre-build the same way. This is required because `@oxy.so/api` imports `@oxy.so/core/server` (safeFetch, SsrfRejection) — without the core `dist/`, tsc fails TS2307 and downstream TS18046. The federation (`federation.service.ts`) and email (`email.service.ts`) services now route outbound fetches of user/remote-supplied URLs through `safeFetch` (https-only + streaming byte caps) instead of hand-rolled DNS checks.

Build-vs-source distinction: production/Docker consumes the built `dist/` (the Dockerfile builds `packages/contracts` then `packages/core` before `packages/api`); tests consume the TS source via the mappings above. Both are intentional.

## Key Entry Points

- `packages/contracts/src/index.ts` — all public contract exports (schemas, helpers, types)
- `packages/core/src/index.ts` — public root exports; subpath entries `src/session/index.ts`, `src/crypto/index.ts`, `src/civic/index.ts`, `src/inference/index.ts`, `src/server/index.ts`
- `packages/core/src/OxyServices.ts` — the client (`request`, `cache`, `createLinkedClient`) + lazy namespace getters; one class per namespace in `packages/core/src/api/*.ts`; the map from 2.x names is `scripts/codemods/core-3/map.ts`
- `packages/core/src/utils/avatarUtils.ts` — shared avatar visibility logic (platform-agnostic)
- `packages/core/src/utils/accountUtils.ts` — shared account/device helpers (`buildAccountsArray`, `createQuickAccount`, `getAccountDisplayName`, `getAccountFallbackHandle`, `formatPublicKeyHandle`) for non-DTO local account surfaces only; app/user DTO display names come from API `name.displayName`.
- `packages/core/src/api/contacts.ts` — `oxy.contacts.discover(hashedEmails, hashedPhones)` privacy-first contact discovery
- `packages/core/src/api/accounts.ts` / `apps.ts` — the account graph (`oxy.accounts`, `members.*`) and applications (`oxy.apps`, `credentials.*`, `connected.*`, `getPublic(clientId)`); `PublicApplication` type
- `packages/core/src/server/OxyServer.ts` — `OxyServer`: service-token lane, `middleware.*`, server-only namespace methods (`server/namespaces.ts`)
- `packages/core/src/server/index.ts` — public `@oxy.so/core/server` exports
- `packages/core/src/server/auth.ts` — `createOptionalOxyAuth`, `createOxyAuthMiddleware`, `requireOxyAuth`, `getRequiredOxyUserId`
- `packages/core/src/server/rateLimit.ts` — `createOxyRateLimit`
- `packages/core/src/server/safeFetch.ts` — `safeFetch(url, opts)`, `assertSafePublicUrl` (SSRF-safe fetch; DNS-pinned, private-IP denylist, bounded redirects, Bun `{all:true}` lookup-array contract)
- `packages/core/src/server/readResponseBody.ts` — `readResponseBody` / `readResponseJson` (a `safeFetch` body: byte cap + whole-body deadline, never rejects)
- `packages/core/src/server/deadline.ts` — `withDeadline(work, { timeoutMs, signal })` (stop waiting for work that can only be abandoned: a DNS lookup, a read-only fetch; never a write)
- `packages/core/src/server/cors.ts` — `createOxyCors({ appOrigins, allowCredentials })` (deny-by-default allowlist, auto-allows `*.oxy.so`, NEVER wildcard+credentials)
- `packages/core/src/server/verifySecret.ts` — `verifySecret(provided, expected)` (constant-time `crypto.timingSafeEqual` + length guard)
- `packages/core/src/api/reputation.ts` — `oxy.reputation` (read-only reads; awards via `OxyServer.reputation.award`). It declares NO wire types: the family lives in `packages/contracts/src/reputation.ts` (see "Oxy Trust" section)
- `packages/protocol/src/envelope/canonicalJson.ts` — `canonicalize(value)` (recursive key-sort/JCS-style canonical JSON); `signedRecordSigningInput` is beside it in `signingInput.ts`; used by both client signing and server verify
- `packages/core/src/api/identity.ts` — `oxy.identity`: `resolveDid`, `did`, `authMethods`, `rootStatus`, `rotateKey`, `export`, `links.*`, `domains.*`, `backup.*`
- `packages/core/src/api/civic.ts` — `oxy.civic`: `publicCard`, `idPayload`, `buildAttestQrPayload`, `attest`, `validation.*`, `vouch`, `withdrawVouch`, `personhood`, `credentials.*`; QR parsers in `src/civic/payloads.ts` (`@oxy.so/core/civic`)
- `packages/core/src/session/` (`@oxy.so/core/session`) — `SessionClient`, `createSessionClient`, `createSessionClientHost`, session-state projection, account-dialog controller, auth-state store, token-refresh scheduler
- `packages/core/src/session/SessionClient.ts` — `SessionClient.onServerEvent(event, listener)`: generic subscription to named server-pushed Socket.IO events (survives reconnects; unsubscribe fn returned). Consumed via the `useOxyEvent(event, handler)` hook exported from `@oxy.so/services`.
- `packages/core/src/session/identityPin.ts` / `identitySession.ts` — the `sessionMode: 'identity'` pin store + `resolveIdentityPin`/`establishIdentitySession` (issue #691 Phase 1)
- `packages/core/src/utils/commonsDelivery.ts` — `selectCommonsDelivery` (issue #691 Phase 4 automatic delivery decision)
- `packages/api/src/utils/applicationCapabilities.ts` — `APPLICATION_CAPABILITIES`, `IDENTITY_APPROVAL_CAPABILITY`, `hasApplicationCapability` (staff-only `Application.capabilities` vocabulary)
- `packages/api/src/middleware/firstPartyDeviceAccess.ts` — `requireFirstPartyDeviceAccess`, for `/session/device/*`
- `packages/core/src/boot/sessionColdBoot.ts` — `runSessionColdBoot` (device-first cold boot, the SOLE restore chain)
- `packages/core/src/utils/oauthPkce.ts` — `generatePkcePair`, `generateOAuthState`, `buildOAuthAuthorizeUrl` (third-party OAuth + PKCE helpers)
- `packages/services/src/ui/oauth/` — `browserAuthTransport.ts` (`startWebOAuthSignIn`, popup-vs-redirect entry point), `completeOAuthCode.ts` (the one code→session completion path both transports share), `oauthPopup.ts` (popup lifecycle)
- `packages/services/src/ui/utils/oauthReturn.ts` — `tryCompleteOAuthReturn` (consume a `?code=`/`?error=` already on the URL), `replaceUrlAfterOAuthReturn` (restore the deep link + notify the router via `popstate`)
- `packages/services/src/ui/session/identityBinding.ts` — `IdentityBoundSessionError` (thrown by `switchToAccount`/`switchSession` in `sessionMode: 'identity'`)
- `packages/services/src/index.ts` — all public UI SDK exports (web + native); includes `LogoIcon`, `LogoText`
- `packages/services/src/notifications/deviceNotifications.ts` — the ONE `expo-notifications` adapter, reached ONLY as `@oxy.so/services/notifications` (never the root barrel — see Package Boundaries)
- **`packages/services/src/ui/context/OxyContext.tsx`** — auth provider + `useOxy()` (web + native); types in `oxyContextTypes.ts`, account graph in `useOxyAccountGraph.ts`, imperative dialog in `navigation/accountDialogManager.ts` (`openAccountDialog('signin')`)
- `packages/services/src/ui/components/OxyProvider.tsx` — the ONE provider component (device-first cold boot on by default; every consumer including the IdP mounts it the same way)
- `packages/services/src/ui/components/OxyAccountDialog.tsx` — unified account switcher + sign-in dialog (Bloom `<Dialog>`)
- `packages/services/src/ui/components/OxySignInButton.tsx` — official → dialog; `third_party` → OAuth redirect + PKCE
- `packages/services/src/ui/components/OxyConsentScreen.tsx` — the IdP's OAuth consent surface

**NOTE:** `accountUtils.ts` is not a frontend display-name fallback for API user/profile DTOs. API serializers own `name.displayName` (optional); consumers render it when present, then fall back to `getNormalizedUserHandle` — not to `accountUtils`.

## Published Version Notes — breaking changes not signalled by the version number

Durable record of releases whose version number does NOT tell you what changed.
Check here before assuming a range is safe.

### `@oxy.so/core@13.2.0` — a BREAKING change shipped under a MINOR (deprecated)

`13.2.0` changed **`buildPaginationParams`'s return type from `URLSearchParams`
to `Record<string, string>`** — a runtime-breaking change to a function exported
from the package root — and shipped it as a MINOR, so a `^13.0.0` range could
pick it up silently.

- **Affected:** anyone calling `.toString()`, `.get()`, `.append()`, `.set()`,
  `.has()`, `.entries()`, `.forEach()` or `for...of` on the result. Those throw a
  `TypeError` — a runtime failure, not a compile error. Migration: use
  `buildSearchParams`, which is unchanged and still returns a `URLSearchParams`.
- **NOT affected:** anyone passing the result to `makeRequest`/`HttpService` —
  the common case, and the one the change exists to repair. `HttpService` reads
  GET params with `Object.keys(...)`, and `Object.keys(new URLSearchParams(...))`
  is `[]`, so that path was silently dropping the entire query string and
  collapsing every page onto one cache key. Those callers are fixed, not broken.
- **Status:** `13.2.0` is deprecated on npm. npm now resolves `^13.0.0` to
  `13.0.0` rather than `13.2.0`; an explicit `13.2.0` install still works but
  warns. The identical content is published as **`14.0.0`** under the correct
  major — **prefer `^14.0.0`**. `@oxy.so/services@23.1.0` pinned `core@^13.2.0`
  and is deprecated in favour of `23.2.0`, which pins `^14.0.0`.

Full detail: `packages/core/CHANGELOG.md`.

**The rule this cost us:** a publicly exported function's signature is public API
even when you can prove no consumer in this org uses it — the package is on
public npm, and semver exists precisely so consumers you cannot enumerate do not
have to trust your grep. When a change is runtime-breaking rather than type-only,
  take the major.
