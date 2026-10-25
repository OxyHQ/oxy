# Oxy Updates code-signing certificate

`withOxyUpdates` reads exactly one file in this directory:

```
oxy-updates-code-signing.pem
```

It is the **public** half of the Oxy Updates code-signing keypair (RSA 2048,
self-signed, `CN=Oxy Updates Code Signing`, extended key usage Code Signing,
valid 2026-10-24 to 2036-10-24, SHA-256 fingerprint
`E9:1D:40:E6:BA:F7:05:C8:C1:94:FF:89:F8:FD:65:E6:6B:89:DA:AB:26:95:B9:E4:7A:7E:54:28:F5:39:DA:81`).
It is safe to commit, and it lives here rather than in each app repo so that a
key rotation is one `@oxy.so/app-preset` bump instead of one edit per app.

`withOxyUpdates` fails the build when this file is missing or is not a PEM
certificate (`codeSigning: 'require'`, the default), because the certificate is
baked into the native binary: a binary built without it accepts unsigned
manifests for its whole lifetime. `codeSigning: 'auto'` / `false` are for local
development builds only.

## Where the private key lives

- **SSM SecureString `/oxy/oxy-api/UPDATES_CODE_SIGNING_PRIVATE_KEY`** (us-west-2,
  KMS `alias/aws/ssm`), the base64-encoded PKCS#8 PEM. It is the only copy the
  server reads: `deploy-aws.yml` binds it into the oxy-api task definition
  (`TASK_SECRET_OVERRIDES_JSON`) and `services/updates/signing.service.ts` decodes
  it. Runtime secrets are SSM-only (oxy-infra `docs/runbooks/46-app-secrets-in-ssm.md`);
  it is NOT a GitHub Actions secret.
- **Offline backup**: `~/.config/oxy/oxy-updates-code-signing-private-key.b64`
  (mode 0600) on the platform owner's machine, next to the Android release
  keystore, and into the same USB vault.

Without the key, oxy-api answers every manifest request with 503 and refuses
every publish; it never serves an unsigned manifest.

## Provisioning (done 2026-10-25; for the record and for a rotation)

From `packages/api`:

```bash
bun scripts/generate-updates-code-signing.ts \
  ../app-preset/certs/oxy-updates-code-signing.pem \
  ~/.config/oxy/oxy-updates-code-signing-private-key.b64
```

The script writes the certificate here and the private key to the second path
with mode 0600. It refuses a key path inside a git work tree or one that already
exists, and it never prints the key. Then:

```bash
aws ssm put-parameter --profile oxy --region us-west-2 --type SecureString \
  --name /oxy/oxy-api/UPDATES_CODE_SIGNING_PRIVATE_KEY \
  --value file://$HOME/.config/oxy/oxy-updates-code-signing-private-key.b64
```

`--value file://` keeps the key out of the shell history and the terminal.
Commit **only** the certificate.

Verify the server, after a deploy, with the key bound:

```bash
curl -s -D - -o /dev/null \
  -H 'expo-protocol-version: 1' -H 'expo-platform: android' \
  -H 'expo-runtime-version: 1.3.0' -H 'expo-channel-name: production' \
  https://api.oxy.so/updates/v1/apps/<clientId>/manifest
```

It must answer 200 (a 503 means the key is not bound), and the multipart part
must carry `expo-signature: sig="…", keyid="main"` that verifies against this
certificate. The deploy's post-deploy smoke checks exactly that.

## Rotation

The certificate is baked into a native binary at build time, so a rotation only
reaches devices that install a NEW binary carrying the new certificate. Rotate by
generating a new pair to a NEW key path, shipping the new certificate in a store
release of every OTA app first (the plugin's `certificatePath` covers an overlap
where one binary must trust the incoming certificate early), and only switching
the SSM parameter once that release has taken over. Devices still on the old
binary reject manifests signed by the new key, and stop receiving updates.

Binaries built before this certificate was committed verify nothing (every
Commons build up to and including the 1.3.0 test builds; Accounts likewise).
Commons' first signed runtime is 1.4.0. Never publish an update for a runtime
version that only such binaries run: they would run it unverified.
