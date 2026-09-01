# Changelog: `@oxyhq/app-preset`

## 0.3.1

### Fixed

The web `ws` shim resolves through Metro's own empty module again
(`{ type: 'empty' }`), and the `metro/empty-module.js` stub that briefly stood in
for it is gone.

The stub was added to fix a `scaffold-smoke` CI failure. It did not fix it: the
failing path was `resolver.emptyModulePath`, which `metro-config` computes with
`require.resolve` when the config is built, so it never went through the shim at
all. The real fault was in the workflow, which installed the preset by pointing a
`file:` override at a directory outside the generated app. Bun materializes that
as a tree of symlinks, node resolves each one to its realpath, and the preset's
whole `require` graph landed in the wrong checkout. That is fixed in the
workflow.

No behaviour changes for apps installing this package from the registry, where
the preset has always been real files inside the app's own `node_modules`.

## 0.2.0

### Licence: MIT becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`@oxyhq/app-preset` is now Apache-2.0. The code, the API surface and the behaviour are
unchanged in this release. It exists to carry the licence change.

The last published version, `0.1.0`, carried MIT, even though the
repository manifest said AGPL-3.0-only. Apache-2.0 is what both should have
said: it grants everything MIT grants, and adds an express patent grant
and a notice requirement. No existing use becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `0.1.0` stays MIT for anyone who already has it. A licence
change binds future versions only.

`@oxyhq/app-preset` is below 1.0.0, where semver puts the breaking position in the minor
and `^0.1.0` does not accept `0.2.0`. Bumping the minor is therefore the
same signal a major bump gives a 1.x package: no consumer picks this up
without editing their manifest, which is the whole point.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.
