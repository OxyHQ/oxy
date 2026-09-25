# Changelog: `create-oxy-app`

## 0.3.3

### Changed

- Generated apps take `@oxy.so/bloom` `^4.25.1`, the workspace catalog's range.

## 0.3.2

### Fixed

- `@oxy.so/core` was pinned at `^23.3.0` — a PRE-RENAME number. The package was
  `@oxyhq/core` through 23.x and its versions reset at the rename, so the range
  matched nothing on the registry (E404). Because the generated root
  `package.json` repeats that pin in `overrides` **and** `resolutions`, a
  freshly generated app could not `bun install` at all. Now `^1.7.1`, which is
  published and satisfies the `@oxy.so/core: ^1.0.1` peer that services 3.x
  declares.
- The generated AWS deploy workflow no longer enumerates the whole secrets
  context to filter it with `jq`. GitHub reads that expression as an
  exfiltration payload and completes every run `action_required` with ZERO jobs
  until a human approves it — a failure that reads as "no checks reported".
  Each runtime secret is now named individually in `env:`, and that list is the
  allowlist; the empty/placeholder guard is unchanged, because a placeholder
  overwrites a real SSM value and crash-loops the service.

### Changed

- `@oxy.so/services` `^2.0.0` → `^3.0.0` and `@oxy.so/bloom` → `^3.2.1`
  (unpublished at 0.3.1, so it reaches consumers here). Services 2.x capped its
  Bloom peer at major 2, so pairing it with Bloom 3 resolved a second, nested
  Bloom — and Bloom 3's composition contracts are React contexts, which do not
  cross copies. Services 3 is published and peers `@oxy.so/bloom: ^3.2.0`, so a
  generated app now resolves exactly one copy of each.

### Added

- `scripts/assert-oxy-ranges-resolve.mjs`, run by the nightly `scaffold-smoke`
  workflow against the app it generates and BEFORE that workflow overrides every
  Oxy dependency with a HEAD tarball — the blind spot the bad pin shipped
  through. A range that resolves to nothing now fails CI instead of reaching a
  developer's first install.

## 0.3.1

### Changed

- Updated generated projects to the current compatible Oxy SDK release set.
- Removed the CLI's accidental runtime dependency on `@oxy.so/core`.

## 0.2.0

### Licence: MIT becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`create-oxy-app` is now Apache-2.0. The code, the API surface and the behaviour are
unchanged in this release. It exists to carry the licence change.

The last published version, `0.1.1`, carried MIT, even though the
repository manifest said AGPL-3.0-only. Apache-2.0 is what both should have
said: it grants everything MIT grants, and adds an express patent grant
and a notice requirement. No existing use becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `0.1.1` stays MIT for anyone who already has it. A licence
change binds future versions only.

`create-oxy-app` is below 1.0.0, where semver puts the breaking position in the minor
and `^0.1.1` does not accept `0.2.0`. Bumping the minor is therefore the
same signal a major bump gives a 1.x package: no consumer picks this up
without editing their manifest, which is the whole point.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.
