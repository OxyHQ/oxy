# Changelog: `create-oxy-app`

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
