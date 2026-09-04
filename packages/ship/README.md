# @oxyhq/ship — `oxy-ship`

Publish Expo OTA updates to the self-hosted **Oxy Updates** service (the
expo-updates protocol server inside `oxy-api`). Runs under Bun and Node.

## Auth

`oxy-ship` authenticates with a `service`-type `ApplicationCredential` for the
target app, granted the `updates:publish` scope. The credential's `applicationId`
must equal the app being published to (the CLI reads it from the minted service
token — you never pass it).

| Flag | Env | Default |
|------|-----|---------|
| `--client-id` | `OXY_SHIP_CLIENT_ID` | — (required) |
| `--secret` | `OXY_SHIP_SECRET` | — (required) |
| `--url` (or `--api-url`) | `OXY_API_URL` | `https://api.oxy.so` |

Every command accepts `--json` for machine-readable stdout (progress goes to
stderr, so stdout stays clean for CI parsing).

## Commands

```bash
# Export + publish the current project to a channel (both platforms by default)
oxy-ship publish --channel production [--platform ios|android|all] \
                 [--rollout 25] [--message "..."] [--runtime-version 1.2.3] \
                 [--dist-dir dist] [--project-dir .] [--skip-export] [--dry-run]

# Emergency rollback: mark the channel head rolled_back (previous update becomes head)
oxy-ship rollback --channel production --runtime-version 1.2.3 --platform ios

# Fall back to the binary-embedded update for a runtime+platform
oxy-ship rollback-to-embedded --channel production --runtime-version 1.2.3 --platform ios

# Promote an existing update into another channel (new UUID, same assets)
oxy-ship promote --update-id <uuid> --to-channel production [--rollout 100]

# List the app's channels
oxy-ship channel:list

# List recent updates (optionally filtered)
oxy-ship update:list [--channel production] [--runtime-version 1.2.3] [--platform ios] [--limit 20]
```

`publish` derives `gitCommit`/`gitBranch` from `git rev-parse` (overridable with
`--git-commit`/`--git-branch`, or `GITHUB_SHA`/`GITHUB_REF_NAME` in CI).

## What `publish` does

1. `expo export` (skippable with `--skip-export`) → reads `dist/metadata.json`.
2. `expo config --json --type public` → `runtimeVersion` (appVersion policy) and
   `extra.expoClient` (so `Constants.expoConfig` works after an OTA update).
3. Content-addresses every asset (sha256) + computes its expo key (md5).
4. `assets/init` → presigned PUT for anything not already stored → uploads →
   `assets/complete` (HEAD-verified).
5. `POST /updates` once per platform (channel created on demand).

`--dry-run` performs steps 1–3 and prints a summary without contacting the API.

## CI

Copy `templates/publish-update.yml` into an app repo. It publishes to
`production` on push to `main`. The workflow intentionally does not run for
pull requests, so untrusted pull request code and metadata cannot access the
OTA publishing credentials.
