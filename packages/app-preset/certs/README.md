# Oxy Updates code-signing certificate

`withOxyUpdates` looks for exactly one file in this directory:

```
oxy-updates-code-signing.pem
```

It is the **public** half of the Oxy Updates code-signing keypair. It is safe to
commit, and it lives here rather than in each app repo so that a key rotation is
one `@oxyhq/app-preset` bump instead of one edit per app.

The file is absent until the ecosystem keypair is generated. While it is absent
`withOxyUpdates` still wires the update URL, but the resulting binaries do **not**
verify manifest signatures, and it emits a build warning saying so.

## Provisioning (one time, by the platform owner)

From `packages/api` in the OxyHQServices repo:

```bash
bun scripts/generate-updates-code-signing.ts \
  ../app-preset/certs/oxy-updates-code-signing.pem
```

That writes the certificate here and prints the base64-encoded private key PEM to
stdout. Then:

1. Set the printed value as the GitHub Actions secret
   `UPDATES_CODE_SIGNING_PRIVATE_KEY` on the OxyHQServices repo. The deploy
   workflow syncs it to SSM `/oxy/oxy-api/UPDATES_CODE_SIGNING_PRIVATE_KEY`, and
   oxy-api reads it in `services/updates/signing.service.ts`.
2. Commit **only** the certificate. The private key is never written to disk by
   the script and must never enter the repo.
3. Clear the terminal scrollback.

Verify the server picked it up: a manifest request that asks for a signature must
stop returning HTTP 500.

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'expo-protocol-version: 1' -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 1.0.0' -H 'expo-channel-name: production' \
  -H 'expo-expect-signature: sig, keyid="main", alg="rsa-v1_5-sha256"' \
  https://api.oxy.so/updates/v1/apps/<clientId>/manifest
```

## Rotation

The certificate is baked into a native binary at build time, so a rotation only
reaches devices that install a NEW binary carrying the new certificate. Rotate by
generating a new pair, shipping the new certificate in a store release first, and
only switching the server's private key once that release has taken over. Devices
still on the old binary will reject manifests signed by the new key.
