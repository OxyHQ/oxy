# Disposable Android ContentProvider fixture

Build-only harness for I11. It copies four unchanged services Kotlin sources into a minimal host APK and invokes the real Android ContentResolver from two separately installed peer APKs. Host and allowed peer share one disposable certificate; the third APK has a different certificate. All three manifests declare separate UIDs, no sharedUserId. There is no Commons identity module, backend session, network permission or user identity in these fixtures.

Build on an installed Android36 SDK and Java21 (Java source/target17):

```sh
python3 scripts/rehearsal/android-device-session/build.py --sdk /path/to/Android/Sdk --java-home /path/to/java21
```

Gradle8.13 is bootstrapped inside this directory and checked against fixed distributionSHA256 `20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78`; AGP8.12/Kotlin2.1.20/build-tools35/security-crypto1.1.0-alpha06 are explicit. Build outputs, Gradle cache and temporary files stay here. The fixture keystore password is a public fixture constant. The builder verifies all Gradle distribution files, copies of SDK source, APK signatures and manifest absence of sharedUserId. `.tooling/apk-proof.json` records exact artifacts. No adb command is executed by the builder.

Root operates only the disposable AVD Oxy1519Root20261003 / emulator-5580. Before any install, root checks the exact emulator/AVD identity and the absence of third-party packages, compares APK hashes with proof, and verifies these package IDs are absent. If the device already contains any of the fixtures or any identity, stop rather than replacing or clearing it. No physical Pixel or other AVD is in scope. Root reviews source/proof before executing:

```sh
adb -s emulator-5580 install scripts/rehearsal/android-device-session/host/build/outputs/apk/debug/host-debug.apk
adb -s emulator-5580 install scripts/rehearsal/android-device-session/peer/build/outputs/apk/debug/peer-debug.apk
adb -s emulator-5580 install scripts/rehearsal/android-device-session/foreign/build/outputs/apk/debug/foreign-debug.apk
adb -s emulator-5580 shell am instrument -w -e phase begin earth.mention.app.dev/so.oxy.fixture.ProbeInstrumentation
adb -s emulator-5580 shell am instrument -w -e phase foreign onl.alia.app.dev/so.oxy.fixture.ProbeInstrumentation
adb -s emulator-5580 shell am instrument -w -e phase finish earth.mention.app.dev/so.oxy.fixture.ProbeInstrumentation
```

Do not use a default adb device or install-replace. Require fixtureStatus=PASS with checks5/4/8 and instrumentation code-1 for the three phases, plus actual distinct UID readbacks. Begin refuses overwriting an existing slot; foreign read/write/clear must be denied; finish proves the original slot survived foreign attempts, then checks replacement/read and clear/absent in the host’s real encrypted store. No credential contents are printed. On an assertion failure preserve the fixture and report it; do not force-clear it to obtain PASS.

This tests the shared credential slot’s native boundary and primitives. Replacement/clear are not backend account switching, server logout, OAuth/SSO, published SDK adoption or cold-boot acceptance. Those I11 criteria remain separate and pending.
