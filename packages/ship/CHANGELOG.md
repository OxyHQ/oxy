# Changelog: `@oxy.so/ship`

## 2.0.0

### Breaking: GitHub trusted publishing replaces the client secret

`oxy-ship` no longer reads or accepts a secret. `--secret` / `OXY_SHIP_SECRET`
are gone, and there is no fallback. In a GitHub Actions job with
`permissions: id-token: write` it requests a GitHub OIDC token addressed to the
Oxy API origin and exchanges it at `POST /auth/service-token/github-actions`
for a five-minute service token carrying exactly `updates:publish` for one
application (oxy ADR 0057). The token is re-minted from a fresh GitHub token a
minute before it expires, so a long export and upload never outlives it.

- `--client-id` / `OXY_SHIP_CLIENT_ID` is now the application's PUBLIC client id
  (`oxy_dk_…`, the one in the manifest URL), not a service credential.
- The application must trust the repository as a publisher: an Oxy app declares
  it in the first-party registry (`trustedPublishers`, applied by the seed), a
  third-party app registers it at `POST /applications/:appId/trusted-publishers`
  (see the README).
- Outside such a job every command that talks to the API refuses with a clear
  message; rollback, promote and rollout by hand are the Console's Updates tab.
- `templates/publish-update.yml` needs no repository secret: it declares
  `permissions: contents: read, id-token: write`, publishes on push to `main`
  only, and runs the lockfile-pinned CLI with `bunx --no-install` (the bare npm
  name `oxy-ship` is not ours, so `bunx oxy-ship` without the devDependency
  would have fetched a stranger's package).
- `@oxy.so/core` is no longer a dependency; `@oxy.so/contracts` is type-only and
  moved to `devDependencies`, so installing the CLI pulls no Oxy runtime.

## 1.1.1

### Changed

- Package against core 7 and contracts 6. Ship APIs are unchanged.

## 0.2.0

### Licence: AGPL-3.0-only becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`@oxy.so/ship` is now Apache-2.0. The code, the API surface and the behaviour are
unchanged in this release. It exists to carry the licence change.

This is a widening. Every right the AGPL granted you, Apache-2.0 grants too,
and Apache-2.0 additionally drops the network copyleft and adds an express
patent grant. Nobody has to do anything, and no existing use of this package
becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `0.1.0` stays AGPL-3.0-only for anyone who already has it. A licence
change binds future versions only.

`@oxy.so/ship` is below 1.0.0, where semver puts the breaking position in the minor
and `^0.1.0` does not accept `0.2.0`. Bumping the minor is therefore the
same signal a major bump gives a 1.x package: no consumer picks this up
without editing their manifest, which is the whole point.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.
