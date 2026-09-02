# Changelog: `@oxyhq/protocol`

## 0.2.1

### Changed

- Replaced the duplicate elliptic/bn.js secp256k1 implementations with one
  audited `@noble/curves` implementation shared by Node, browser and React
  Native builds. Public wire formats and signatures remain compatible.

## 0.2.0

### Licence: AGPL-3.0-only becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`@oxyhq/protocol` is now Apache-2.0. The code, the API surface and the behaviour are
unchanged in this release. It exists to carry the licence change.

This is a widening. Every right the AGPL granted you, Apache-2.0 grants too,
and Apache-2.0 additionally drops the network copyleft and adds an express
patent grant. Nobody has to do anything, and no existing use of this package
becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `0.1.6` stays AGPL-3.0-only for anyone who already has it. A licence
change binds future versions only.

`@oxyhq/protocol` is below 1.0.0, where semver puts the breaking position in the minor
and `^0.1.6` does not accept `0.2.0`. Bumping the minor is therefore the
same signal a major bump gives a 1.x package: no consumer picks this up
without editing their manifest, which is the whole point.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.
