# ADR 0057 — OTA updates publish from GitHub Actions by trusted publishing, with no stored secret

- Status: accepted
- Date: 2026-11-05
- Supersedes: publishing with a `service` `ApplicationCredential` holding
  `updates:publish`, stored as the repository secrets `OXY_SHIP_CLIENT_ID` /
  `OXY_SHIP_SECRET` (`@oxy.so/ship` ≤ 1.1.1).
- Builds on: [0049](0049-first-party-platform-authority.md) (a token minted for an
  application's own CI is external authority, never an own workload) and
  [0056](0056-first-party-operator-authority.md) (an Oxy application's
  operator configuration is declared in code and applied by the seed).

## Context

Oxy Updates (the expo-updates server in oxy-api) accepts a publish from a
service token carrying `updates:publish` whose `appId` is the target
application. Until now the only way a CI job got one was a long-lived
`service` credential per app, its secret copied into the repository's GitHub
secrets. Rolling OTA out to the ~18 product repositories meant 36 secrets that
never expire, that anyone with repository admin can read back into a workflow,
and that have to be rotated by hand. npm, PyPI and crates.io removed the same
problem with trusted publishing: the CI provider vouches for the job, and the
registry trusts a declared workflow instead of a stored key.

## Decision

1. **An application declares GitHub trusted publishers.** A row in
   `github_trusted_publishers` names an exact `repository` (`Owner/Name`,
   compared case-insensitively), GitHub's numeric `repository_id` (compared
   exactly), an exact `ref` (default `refs/heads/main`) and optionally one
   `workflow` file. The numeric id is read from GitHub's REST API at
   registration (a private repository passes it explicitly), so a repository
   deleted and recreated under the same name by someone else never matches.
   - **Oxy's own applications declare them in code**: `trustedPublishers` on
     the application's entry in `seedOxyApplicationsSpecs.ts`, every one
     `refs/heads/main` + `.github/workflows/publish-update.yml` of the app's
     OxyHQ repository, with the numeric id written beside the name. The
     `seed-oxy-applications` run makes the stored set EXACTLY the declaration
     (absent = none; an undeclared row is deleted; a repository GitHub renamed
     under the same id takes the declared name), as it does for operator keys.
     The API refuses writes to an own application's publishers with
     `409 FIRST_PARTY_TRUSTED_PUBLISHERS_IN_CODE`.
   - **Third-party applications manage them through the API**:
     `/applications/:appId/trusted-publishers` with the credential
     permissions — `credentials:read` lists (for any application),
     `credentials:create` registers, `credentials:revoke` deletes. The numeric
     id is read from GitHub at registration unless given.
   `updates:publish` is own-tenant authority (an application's own updates to
   its own installs, which its owners can already publish from the Console), so
   no platform-trust or staff gate applies.
2. **The exchange is `POST /auth/service-token/github-actions`** with
   `{ clientId, token }`: the application's public client id and the job's
   GitHub OIDC token. The API verifies the RS256 signature against GitHub's JWKS
   (cached ten minutes; an unknown `kid` refetches at most once a minute; a
   failed refresh keeps serving still-cached keys), `iss` exactly
   `https://token.actions.githubusercontent.com`, `aud` exactly the API's own
   origin (`OXY_API_URL`, `https://api.oxy.so`; the value every other issuer and
   audience in the API reads), and `exp`/`nbf`/`iat` with 60 seconds of skew.
   Only `push` and `workflow_dispatch` events may publish: an allowlist, so
   `pull_request`, `pull_request_target` (which carries the base ref) and every
   future event are refused. The claims must then match a publisher of THAT
   application. Rate-limited per `hashedIpKey`; no address is stored.
3. **The token is the credential path's token.** It comes from the same
   `mintServiceToken`, with `authority: 'external'`, the 300-second shared
   lifetime, and exactly `['updates:publish']` — fixed, never derived from the
   application's grants, which first-party applications do not hold
   ([0049](0049-first-party-platform-authority.md)). Its `credentialId` is
   `tp_<publisher id>`. Downstream it is indistinguishable from a credential
   token except by that prefix, which the live resolver routes on exactly as it
   routes `wl_` to a workload binding: the publisher row, its application
   (active and trusted), and the owner (active, unfenced, unsupervised) are
   re-read on every request. Deleting the publisher cuts every outstanding
   token off at its next request.
4. **`oxy-ship` 2 authenticates only this way.** With
   `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN` present it requests a GitHub token
   addressed to the API origin, exchanges it, and re-mints a minute before
   expiry. There is no secret flag and no fallback: hand operations (rollback,
   promote, rollout) are the Console's Updates tab, which uses the person's own
   session and `updates:manage`. The template workflow runs on push to `main`
   with `permissions: id-token: write, contents: read` and executes the
   lockfile-pinned CLI with `bunx --no-install`, since the bare npm name
   `oxy-ship` is not ours.

## Consequences

- A product repository needs no secret to publish; registration is one API call
  per repository, and revocation is one `DELETE`.
- Anyone who can push to the registered ref (or, without a pinned `workflow`,
  add a workflow on it) can publish an OTA update for that application. Branch
  protection on `main` is therefore part of the publish boundary; pin the
  workflow file when other workflows run on `main`.
- A GitHub OIDC token is a bearer proof for its few minutes and is not made
  single-use, as with npm's trusted publishing: it is addressed to Oxy alone
  (`aud`), and a job that leaks it in its own logs lets the reader publish
  for that one application until the GitHub token expires, nothing more.
- A publisher is not an `ApplicationCredential`: it has no secret, no rotation
  and no row in the credential audit trail. Registration, deletion and every
  exchange (repository, ref, workflow, sha, run id) are logged, and
  `last_used_at` records the last exchange.
- `service` credentials with `updates:publish` remain possible in the API, but
  nothing Oxy ships uses one for publishing.
- Adding an Oxy app to OTA is a registry change plus a seed run
  (`ONLY_APPS=<name>`), reviewed like any other first-party configuration; there
  is no hand-registered publisher to drift from the code.
- A third-party application may now hold an `updates:publish` service token
  (through a publisher only), although it still cannot hold a `service`
  credential for that scope: the publisher is the narrower instrument, bound to
  one repository, ref and workflow and to that one scope.
