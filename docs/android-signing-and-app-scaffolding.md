# Android release signing, device discovery and app scaffolding

## Android release signing

Every Oxy Android app is signed with the ONE ecosystem release key (offline vault copy plus a
per-machine keystore, alias `oxy`), never a per-app one. Apps no longer share a UID
([phase-2-shared-uid-migration.md](identity/phase-2-shared-uid-migration.md)): Commons alone holds the identity and serves it,
and the device session, over providers guarded by the `signature`-level permissions
`so.oxy.permission.IDENTITY` / `DEVICE_SESSION` (`withOxySharedPermissions`). They also check the
caller's package against Commons' allow-list (`OxyCallerPolicy.kt`) and its certificate. A
differently signed app is refused by Commons and fails to install next to its siblings
(`INSTALL_FAILED_DUPLICATE_PERMISSION`).

Release signing is applied by `@oxy.so/services/plugins/withOxySharedPermissions` itself
(`withOxyReleaseSigning`, services 13.4.0+; also via `['@oxy.so/app-preset', {}]` 5+), so an app
cannot declare the permissions without it; apps list no signing plugin
(`@oxy.so/app-preset/plugin/withOxyAndroidRelease` is removed and throws). It **fails closed**:
release is always signed by `signingConfigs.release` from the Gradle properties
`OXY_UPLOAD_STORE_FILE`, `OXY_UPLOAD_STORE_PASSWORD` or `OXY_UPLOAD_STORE_PASSWORD_FILE`,
`OXY_UPLOAD_KEY_ALIAS=oxy` (key password optional, defaults to the store's). The
`oxyVerifyReleaseSigning` task fails every release variant whose effective certificate is not
SHA-256 `b8ab3746466ce4569d7a6a0ffa1eed91bc375174d503613987ca09cb33d6a58d` (debug key,
EAS-managed key, wrong alias).

On a machine without `a user-level `gradle.properties``, pass them as `ORG_GRADLE_PROJECT_OXY_UPLOAD_*`
environment variables (`..._STORE_FILE`, `..._STORE_PASSWORD_FILE`). `OXY_UPLOAD_SIGN_DEBUG=true`
opts debug builds into the same key and check (a dev client next to real Oxy apps). Dev/prod
coexistence uses an `APP_VARIANT=development` variant signed with the same key. Keep the key
offline and enable Play App Signing.

The incident behind the fail-closed check: a debug-signed Mention release took both
permissions on a phone and every correctly signed Oxy app then failed with
`INSTALL_FAILED_DUPLICATE_PERMISSION`.

**On-device hazard:** never clear, uninstall or `adb install -r` **Commons** on a device holding a
real identity: its Keystore is the identity, recoverable only from the Block Store backup or the
recovery phrase. Other apps have their own UIDs and cannot touch it. See
[platform-features.md](engineering/platform-features.md#on-device-testing-safety).

## Android device discovery from WSL

An empty Linux `adb devices -l` inside WSL does not prove no Android device is connected: the
Windows Android SDK may own the USB connection and ADB server. Before declaring physical testing
unavailable, locate the Windows SDK's `platform-tools/adb.exe` (under `/mnt/c/Users/<user>/AppData/Local/Android/Sdk/`)
and run its `devices -l`. Use that same executable and an explicit `-s <serial>` for the whole
session; do not restart the server or rebind USB to a second ADB without a reason. Convert WSL
artifact paths with `wslpath -w` when passing files to Windows ADB; `exec-out screencap -p` can be
redirected straight into a WSL file. Discovery is read-only and does not authorize clearing an
app's storage or changing a device's identity (the Commons hazard above applies).

## App scaffolding

`bun create oxy-app` (`packages/create-oxy-app`) generates the canonical `packages/frontend` +
`packages/backend` + `packages/shared-types` monorepo. **Every new Oxy app is born on
PostgreSQL**: drizzle + `@oxy.so/db`, a migrator with a required `--target-database` and
`pre`/`post` phase markers, and `docker-compose.postgres.yml`; never Mongoose. The compose image
is plain `postgres:17-alpine`; PostGIS needs both `REQUIRED_EXTENSIONS` in `migrate.ts` and a swapped image plus a
privileged role (a new database is cloned from `template1`, which the image never seeds).

Shared Expo config lives in `@oxy.so/app-preset`: apps upgrade by bumping the preset, never by
copy-pasting config. OTA updates are served by oxy-api (`/updates/v1`), published via
`@oxy.so/ship`.

The generated migrator takes `--phase=pre|post|all` (default `all`); a deploy workflow passes `pre`
and `post` explicitly (`packages/create-oxy-app/templates/backend/packages/backend/src/db/migrate.ts`).
Migration rules: [postgres-and-drizzle.md](postgres-and-drizzle.md).

## Publishing and testing lessons from @oxy.so/core incidents

- **Verify a published package by LOADING it under the target runtime, and baseline the consumer
  before blaming or absolving the bump.** `@oxy.so/core` 1.7.0's `dist/esm` shipped an extensionless
  `await import('../server/workloadIdentity')`: Node's resolver throws `ERR_MODULE_NOT_FOUND`, the
  surrounding catch read it as "this host cannot attest", and `getServiceToken()` failed with
  `Service credentials not provided` on a task whose identity is its role. Invisible to `tsc`,
  jest, `require()` and Bun. 1.7.1 fixed the extension and was itself unloadable (built from a
  `main` that had moved). Publishing from HEAD publishes whatever else HEAD accumulated. Run
  `node -e "import('<pkg>')"` inside the target image before trusting a version, and run the
  consumer's suite at its `origin/main` FIRST.
- **Jest runs on Node; anything touching sockets or runtime APIs needs a `bun test` that exercises
  the real path.** core 6.9.0's session-revocation feed passed Socket.IO's `autoUnref`
  (`ws._socket.unref()`), which does not exist on Bun's WebSocket: every Bun backend crashed the
  first time a signed-in request opened the feed. 6.9.1 limits `autoUnref` to Node
  (`AUTO_UNREF_SUPPORTED`) and a Bun CI test opens the real feed. Use 6.9.1 or later.
