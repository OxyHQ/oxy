# Releasing an npm package

Every public npm package OxyHQ owns is published by GitHub Actions, never from a laptop.
**Merging a version bump to `main` is the release.** The mechanism (the shared
`.github/workflows/npm-release.yml`, its plan/build/publish/tag jobs, the CI check, the
tarball path and why lifecycle scripts do not run) is described once, in
[engineering/package-rules.md](engineering/package-rules.md#publishing). This page is the
checklist for the person shipping a package.

## Releasing

1. Bump `version` in the package's `package.json` and commit `bun.lock` with it, in a normal PR.
   Dependencies bumped in the same commit publish first, so a contracts + SDK bump is one PR.
2. Merge it. The push to `main` runs the repository's `release-packages.yml`, which publishes every
   public package whose version is not on npm yet once CI passed on that exact commit.
3. If the run failed for a transient reason (registry, npm trust settings), re-run it. A re-run keeps
   the shared workflow's commit it started with, so after a fix to the shared workflow use
   Actions → Release packages → Run workflow on `main` instead. Any later push also retries
   whatever is still unpublished.

The dist-tag comes from the version: a release is `latest` (never moves backwards); a prerelease
publishes under the name of its line (`2.0.0-next.1` → `next`, `4.11.0-oxy-one.0` → `oxy-one`), and
one that names no line (`2.0.0-0`) is refused. Only `main` releases.

## What a public package must have

- Its gates in the repository's CI. The release runs no tests; it requires CI to be green on the
  merged commit.
- No `prepublishOnly`, `prepack` or `prepare` script as a release step: the release never runs the
  first and packs with `--ignore-scripts`. Packaging checks that must hold for the shipped tree
  (every export ships, built entry points load) go in `postbuild`, so CI's builds and the release's
  one build both run them.
- `private: true` on anything that is not an npm package (an app, an extension): every other
  manifest whose version the registry lacks is published.
- A `files` list that ships what consumers need and no `.tsbuildinfo`; every declared entry point
  (`main`, `module`, `types`, `bin`, `exports`) inside the tarball.
- A trusted publisher, configured once on npmjs.com at
  `https://www.npmjs.com/package/<name>/access` → Trusted Publisher → GitHub Actions:
  organization `OxyHQ`, the repository that holds the package, workflow `release-packages.yml`
  (npm checks the calling workflow, not `npm-release.yml`), environment `npm`, allowed action
  `publish`.

## A brand-new package

Check first whether npmjs.com lets you configure a trusted publisher for a name that does not exist
yet. If it does not, the owner publishes the very first version once and configures the trusted
publisher straight away; every later version goes through the workflow. Until then a merged new
public package makes its repository's release fail at `publish`, so keep it `private: true` until
the owner is ready.

The caller workflow every publishing repository carries, and its inputs (`ci_workflow` when the
CI file is not `ci.yml`), are in this repository's
[`release-packages.yml`](../.github/workflows/release-packages.yml).
