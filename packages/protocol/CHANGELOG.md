# Changelog: `@oxy.so/protocol`

## 1.2.0

### Added

- `loadCommonsIdentityBridge()` and the `CommonsIdentityBridge` type: the
  client of the identity Commons holds on Android (`describe`,
  `proveIdentity`, `deriveScopedSeed`, `signSocialReceive`), over the
  `OxyIdentity` native module in `@oxy.so/services` 11. Every native answer is
  narrowed to its exact shape; anything else is `null`. Web and Node always
  resolve `null`.
- `tweakAddSecp256k1PrivateKey` in `@oxy.so/protocol/secp256k1`: the scalar
  step of BIP32 non-hardened child derivation.

### Removed

- `loadSharedIdentityBridge` and `SharedIdentityBridge`. The raw-key export
  they read (`getShared`) no longer exists: no Oxy app shares a UID, and
  Commons never hands out the private key (OxyHQ/oxy#1388).

## 1.1.4

### Changed

- Published against `@oxy.so/contracts` 4.x: 1.1.3 required `^3.0.0`, so
  every app on contracts 4 installed a second, nested contracts 3.x.

## 1.1.3

### Changed

- Published against `@oxy.so/contracts` 3.x: 1.1.2 required `^2.1.0`, so
  every app on contracts 3 installed a second, nested contracts 2.x.

## 1.1.2

### Changed

- Published against `@oxy.so/contracts` 2.x: 1.1.1 still required `^1.4.0`,
  so every app on contracts 2 installed a second, nested contracts 1.x.

## 0.2.1

### Changed

- Replaced the duplicate elliptic/bn.js secp256k1 implementations with one
  audited `@noble/curves` implementation shared by Node, browser and React
  Native builds. Public wire formats and signatures remain compatible.

## 0.2.0

### Licence: AGPL-3.0-only becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`@oxy.so/protocol` is now Apache-2.0. The code, the API surface and the behaviour are
unchanged in this release. It exists to carry the licence change.

This is a widening. Every right the AGPL granted you, Apache-2.0 grants too,
and Apache-2.0 additionally drops the network copyleft and adds an express
patent grant. Nobody has to do anything, and no existing use of this package
becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `0.1.6` stays AGPL-3.0-only for anyone who already has it. A licence
change binds future versions only.

`@oxy.so/protocol` is below 1.0.0, where semver puts the breaking position in the minor
and `^0.1.6` does not accept `0.2.0`. Bumping the minor is therefore the
same signal a major bump gives a 1.x package: no consumer picks this up
without editing their manifest, which is the whole point.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.
