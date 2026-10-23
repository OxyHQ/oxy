# Changelog: `@oxy.so/protocol`

## 1.5.1

### Changed

- Package against contracts 6. Protocol exports and signed wire formats are unchanged.

## 1.5.0

Same `@oxy.so/contracts`.

### Fixed

- `readBoundedBytes` / `readBoundedJson` give the WHOLE body a deadline
  (`timeoutMs`, third argument, default `DEFAULT_CLIENT_BODY_TIMEOUT_MS`,
  15 s), not only a byte cap. A node that sent its headers and then stalled
  the body held the reader, and with it the background ingest, open forever;
  it now ends with the stream destroyed and a `ResponseTimeoutError`, distinct
  from `ResponseTooLargeError`, which a caller treats as transient.

### Added

- `ResponseTimeoutError` (carries `timeoutMs`).
- `NodeClientOptions.bodyTimeoutMs` (JSON responses, default
  `DEFAULT_CLIENT_BODY_TIMEOUT_MS`) and `blobBodyTimeoutMs` (`getBlob`,
  default `DEFAULT_BLOB_BODY_TIMEOUT_MS`, 60 s);
  `DidWebResolverOptions.bodyTimeoutMs` for the `did.json` read.

## 1.4.1

Needs `@oxy.so/contracts` ^5.0.0.

### Fixed

- Depends on `@oxy.so/contracts` `^5.0.0` (1.4.0 was published with
  `^4.24.0`). `@oxy.so/core` 6 pins contracts 5.0.0 and `@oxy.so/services`
  11.16 depends on `^5.0.0`, so an app installing them with protocol 1.4.0
  nested a second, 4.x contracts under protocol. No source change: protocol
  already builds and tests against contracts 5.

## 1.4.0

Same `@oxy.so/contracts`.

### Changed

- The optional `expo-crypto`, `expo-secure-store` and `expo-modules-core` peers
  admit Expo SDK 58 (`<59.0.0`; they were `<58.0.0`).

## 1.3.0

Needs `@oxy.so/contracts` 4.17.0.

### Added

- `@oxy.so/protocol/sign`: `signMessage`, `verifySignature`, `signEnvelope`,
  `verifyEnvelopeSignature` on their own entry, so a client loads the signer
  (and `@noble/curves`) where it signs, while the root it imports at startup
  for hashing and platform loaders drops it under tree shaking.

### Changed

- `verifyEnvelope` checks the envelope's shape with
  `signedRecordEnvelopeCheck` from `@oxy.so/contracts/client` instead of the
  Zod schema (same verdict, by contracts' parity test), so the root entry no
  longer reaches Zod.

## 1.2.1

- No code change: the same contents as 1.2.0, republished while npm was
  still processing 1.2.0.

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
