# Forge candidate local regression controls

Run with Node against an explicit materialized package directory:

```sh
node scripts/forge-candidate-regression.cjs /path/to/node-forge stock
node scripts/forge-candidate-regression.cjs /path/to/patched/node-forge candidate
```

An optional fourth argument is an OWN synthetic key fixture JSON with privateKey/publicKey PEM strings. It permits the same local key across runs; never supply a user/provider credential or real signing identity. Without it a fresh local synthetic RSA key is generated. The script prints only public-key fingerprint and package-file hashes, never key material.

192 controls cover eight digest algorithms and three distributions: source, forge.min.js, forge.all.min.js. Controls use ordinary Node signatures plus Forge's supported own-key signing API with normal PKCS#1 v1.5 padding for deterministic ASN.1 field variants. MD5 requires NULL; SHA digests preserve optional NULL. Malformed structure, nonempty NULL, trailing DER, and wrong digest are compared with Node/OpenSSL rejection. Browser bundles load in isolated VM contexts with inert jQuery event stubs, not a real browser.

Stock mode deliberately expects the original acceptance of extra nested fields and nonempty NULL, exposing baseline behavior. Candidate mode requires their rejection while retaining valid compatibility. Local source-only removal of each nested-count, empty-NULL, and outer-count guard was detected by the candidate assertions. Those mutations do not establish bundle mutation coverage.

These are known-key protocol validation controls, not a no-key forgery demonstration, a complete security review, Expo integration tests, or production-image evidence. Passing them does not authorize deployment or an audit policy change.
