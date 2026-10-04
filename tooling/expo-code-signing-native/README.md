# Native Expo code signing

Private Node tooling adapter for the synchronous public API consumed by Expo CLI 57.0.23 and expo-updates 57.0.21. RSA signing and verification use Node/OpenSSL; maintained Peculiar ASN.1 schemas encode and strictly parse X.509 certificates and CSRs. This is an independent implementation, not node-forge and not a general implementation of the Forge object model. It runs in Node tooling, never Hermes or a published Oxy SDK runtime.

Run `bun run test` in this directory for public API compatibility, independent OpenSSL interoperability, and malformed ASN.1/signature rejection. Synthetic fixture keys stay in memory or a private temporary directory that is removed after the tests.
