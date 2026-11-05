# @oxy.so/ship — `oxy-ship`

Publish Expo OTA updates to the self-hosted **Oxy Updates** service (the
expo-updates protocol server inside `oxy-api`). Runs under Bun and Node.

## Auth: GitHub trusted publishing, no secret

`oxy-ship` holds no credential. It runs inside a GitHub Actions job with
`permissions: id-token: write`, asks GitHub for an OIDC token addressed to the
Oxy API origin (`https://api.oxy.so`), and exchanges it at
`POST /auth/service-token/github-actions` for a five-minute service token
carrying exactly `updates:publish` for one application (oxy
[ADR 0057](https://github.com/OxyHQ/oxy/blob/main/docs/adr/0057-github-trusted-publishing-for-ota-updates.md)). The
API mints it only when the token's repository (name AND numeric id), ref and, if
registered, workflow file match a **trusted publisher** of that application, and
the event is `push` or `workflow_dispatch` — never `pull_request`. The token is
re-minted from a fresh GitHub token when it nears expiry, so a long export does
not outlive it.

| Flag | Env | Default |
|------|-----|---------|
| `--client-id` | `OXY_SHIP_CLIENT_ID` | — (required): the app's PUBLIC client id (`oxy_dk_…`), not a secret |
| `--url` (or `--api-url`) | `OXY_API_URL` | `https://api.oxy.so` |

Outside such a job (`ACTIONS_ID_TOKEN_REQUEST_URL` unset) every command that
talks to the API refuses to run. `publish --dry-run` needs no auth. Rollback,
promote and rollout changes by hand are the Oxy Console's Updates tab.

### Registering a trusted publisher

**An Oxy application** declares its publisher in code: `trustedPublishers` on
its entry in oxy's `packages/api/src/scripts/seedOxyApplicationsSpecs.ts`
(`otaPublisher('OxyHQ/<Repo>', '<numeric repository id>')`, which pins
`refs/heads/main` and `.github/workflows/publish-update.yml`), applied by the
`Seed Oxy applications` workflow (`only_apps: <App name>`, dry run first). The
API refuses to write an Oxy application's publishers
(`409 FIRST_PARTY_TRUSTED_PUBLISHERS_IN_CODE`). GitHub's numeric id:
`gh api repos/OxyHQ/<Repo> -q .id`.

**A third-party application** registers through the API, as someone holding
`credentials:create` on it (the owning account's owner, admin or developer):

```bash
curl -X POST "https://api.oxy.so/applications/$APP_ID/trusted-publishers" \
  -H "authorization: Bearer $OXY_SESSION_ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"repository":"acme/my-app","workflow":".github/workflows/publish-update.yml"}'
```

| Field | Default | Meaning |
|-------|---------|---------|
| `repository` | required | `Owner/Name`, matched case-insensitively |
| `repositoryId` | read from GitHub | GitHub's numeric id; required for a private repository |
| `ref` | `refs/heads/main` | the exact `ref` claim |
| `workflow` | any workflow | `.github/workflows/<file>.yml`, matched against `workflow_ref` |

`GET` the same path lists an application's publishers (`credentials:read`);
`DELETE .../trusted-publishers/<id>` removes one (`credentials:revoke`), and
every token it minted stops working on its next request.

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

Copy `templates/publish-update.yml` into the app repo as
`.github/workflows/publish-update.yml`, set `OXY_CLIENT_ID` in it, add
`@oxy.so/ship` as a devDependency, and declare or register the trusted publisher
above. It
publishes to `production` on push to `main` with `permissions: id-token: write`
and `contents: read`, runs the lockfile-pinned CLI with `bunx --no-install`, and
needs no repository secret.
