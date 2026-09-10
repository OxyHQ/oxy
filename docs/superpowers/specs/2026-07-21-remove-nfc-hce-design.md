# Remove NFC/HCE from Commons — QR-only real-life attestation

**Date:** 2026-07-21
**Status:** Approved (design)
**Scope:** `packages/commons`, repo root `package.json`, `patches/`

## Problem

The repo carries `patches/react-native-hce@0.3.0.patch`, wired through
`patchedDependencies` in the root `package.json`. It rewrites the library's
`android/build.gradle` `jcenter()` calls to `mavenCentral()` because JCenter was
sunset in 2021 and Gradle 9 removed the method outright — without the patch the
Commons Android build fails.

The patch is a symptom, not the disease. `react-native-hce@0.3.0` (published
2025-07-30, the latest release) still ships `jcenter()` and
`com.android.tools.build:gradle:3.5.4` (2019). It also ships no Expo config
plugin, so Commons already hand-writes the `CardService` manifest entry, the
`aid_list.xml`, the NFC permission and the `NDEF_DISCOVERED` intent filter in
`packages/commons/plugins/with-hce.js`. Of the library's 813 lines of Java, only
~410 are real logic (the APDU state machine and NDEF Type 4 encoding); the rest
is legacy-bridge boilerplate.

Patching a third-party dependency violates the project's "no tricky things, no
patches" standard. The options were: own the native code as an Expo module,
fork and publish, or drop the feature.

## Decision

**Drop NFC entirely. Real-life attestation stays QR-only.**

NFC was a convenience layer over a QR flow that already carries the identical
bytes: the NFC tag content is byte-for-byte the string produced by
`buildAttestQrPayload` in `@oxy.so/core`. Removing it costs one tap of
convenience and buys the removal of a patch, an abandoned dependency, a
hand-rolled config plugin, an Android-only code path that can only be verified
on real hardware, and the ongoing maintenance of Kotlin/Java we would otherwise
have to own.

Rejected alternatives:

- **Own Expo module (`@oxy.so/expo-nfc-hce`).** Correct if NFC were load-bearing.
  It is not: the QR path is complete and cross-platform (iOS can never emit HCE
  anyway — Apple gives no HCE to third-party apps, so NFC was always
  Android-emitter-only).
- **Fork and publish `@oxy.so/react-native-hce`.** Trades a patch for ownership of
  an abandoned legacy-architecture library, including its new-architecture risk
  under RN 0.86.
- **Upstream PR to `appidea/react-native-hce`.** Correct citizenship but ships
  nothing: we would stay blocked on a maintainer release, and we would still own
  the missing config plugin.
- **Partial removal (drop the emitter, keep `react-native-nfc-manager` as a
  reader).** Incoherent — with no Oxy device emitting tags, the reader has
  nothing to read. It would leave a native dependency, an NFC permission and a
  scanner button all dead.

## Removal surface

### Root

- Delete `patches/react-native-hce@0.3.0.patch` and the now-empty `patches/`
  directory.
- Delete the `patchedDependencies` block from the root `package.json`.

### Dependencies (`packages/commons/package.json`)

- Remove `react-native-hce`.
- Remove `react-native-nfc-manager`.
- Regenerate `bun.lock` and commit it in the same commit.

### Hooks and tests

- Delete `hooks/nfc/useNfcAttestEmitter.ts` and `hooks/nfc/useNfcReader.ts`
  (the `hooks/nfc/` directory goes with them).
- Delete `__tests__/hooks/useNfcAttestEmitter.test.tsx` and
  `__tests__/hooks/useNfcReader.test.tsx`.

### Native config

- Delete `plugins/with-hce.js`.
- In `app.config.js`, remove the `'./plugins/with-hce'` entry and the
  `['react-native-nfc-manager', { nfcPermission: … }]` entry. This transitively
  drops `android.permission.NFC`, the `android.hardware.nfc.hce` `uses-feature`,
  the `com.reactnativehce.services.CardService` service block,
  `res/xml/aid_list.xml`, the `NDEF_DISCOVERED` intent filter on `MainActivity`,
  and the iOS `NFCReaderUsageDescription`.
- Update the file-header comment in `app.config.js` that explains the shared URL
  scheme in terms of "NFC/deep-link plumbing" — the scheme stays, the NFC
  justification does not.

### Emitter UI (`app/(tabs)/(id)/index.tsx`)

- Remove the `useNfcAttestEmitter` import and call, the `nfcState` value, and
  the AppState foreground gate that existed only to disarm the HCE radio.
- Rename the attest context prefix from `irl-nfc-` to `irl-qr-`.
- Replace the `nfcState === 'emitting' ? t('civic.nfc.active') : …` label with
  the plain flip hint.

### Reader UI (`app/(scan)/index.tsx`)

- Remove the `useNfcReader` import, the `nfcAvailable` / `nfcReading` state, the
  `handleNfcRead` callback and the NFC control button.
- Keep the camera path and `routeParsed` untouched.

### Level-1 card feedback (`scanPulse`)

`scanPulse` existed solely to signal a local HCE read. With no emitter, nothing
can trigger it, so it is dead code and is removed end to end:

- the `scanPulse` shared value and `triggerScanPulse` in `app/(tabs)/(id)/index.tsx`
- the optional `scanPulse` prop and its internal fallback in `components/OxyID/index.tsx`,
  including the pitch nudge that reads it
- the `scanPulse` field in `components/OxyID/tilt-context.tsx`
- the diagonal shine-sweep band in `components/holographic-card.tsx`

### i18n

- Remove the `civic.nfc` block (`active`, `read`) from
  `lib/i18n/locales/en.json` and `lib/i18n/locales/es.json`.

### Docs

- Remove the "NFC Real-Life Attestation (extends Fase 2)" section from the
  OxyHQServices repo-root `AGENTS.md`, via docs-keeper.

## Explicitly retained

Over-deleting here would break the QR flow, so the following stay:

- **`attestGlow` (level-2 feedback).** Driven by the server-pushed
  `civic:attested` socket event, which the QR attestation emits identically.
  Untouched.
- **`app/(scan)/attest.tsx`, `hooks/civic/useAttestAutoDispatch.ts`,
  `hooks/civic/attestStore.ts`.** These serve the OS deep-link entry point: the
  *system* camera scanning the attest QR opens `oxycommons://attest?…` on a cold
  launch with no in-app event to hang the submit off. That path is unaffected by
  the NFC removal. Only their docstrings change, where they cite NFC foreground
  dispatch as the motivating entry point.
- **`app/+native-intent.ts`.** The card deep-link rewrite. One comment mentions
  "QR / NFC tag"; drop the NFC half.
- **`buildAttestQrPayload`, `parseAttestPayload` and the `oxycommons://attest`
  scheme in `@oxy.so/core`.** These are the QR contract.
- **The entire civic backend** (`packages/api/src/routes/civic.ts`, the jury and
  attestation services, the `civic:attested` socket emit). Unchanged.

## Verification

1. `bun install` at the repo root, then confirm `bun install --frozen-lockfile`
   passes. Lockfile lands in the same commit as the `package.json` changes.
2. `bun run --filter commons test` — the baseline drops by the two deleted NFC
   suites; every other suite must stay green.
3. `bunx tsc --noEmit` in `packages/commons`.
4. `bunx expo prebuild --clean --platform android` in `packages/commons`, then
   grep the generated `AndroidManifest.xml` to confirm no `CardService`, no
   `android.permission.NFC`, no `NDEF_DISCOVERED`, and that
   `android/app/src/main/res/xml/aid_list.xml` is absent.
5. Confirm `grep -ri "nfc\|hce" packages/commons --include='*.ts*' --include='*.js' --include='*.json'`
   returns nothing outside of intentionally reworded comments.

## Rollout note

This is a **native** change: the removed modules are unlinked at build time, so
it does not ship over the air. Commons needs a fresh EAS build; an OTA update on
top of an old binary would leave the native NFC service present but unreferenced
(harmless, but the manifest cleanup only lands with a new build).
