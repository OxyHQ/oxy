# AND03 preparation, not device acceptance

Source aa383c5fc and upstream dependency correction82a06bbf8. The [operator plan](../../../packages/commons/acceptance/README.md) restricts this to disposable Commons.dev in root-owned emulator5580. Root alone installs and operates Android. Exact file corruption still requires reviewed preflight, backup and CAS. No Android recovery success is claimed.

Assembly initially failed from duplicate Bouncy Castle providers; alignment to Expo Updates jdk15to18:1.81 passes657 tasks, five JVM identity-vector tests and single-provider dependency readback. Algorithms, stores, caller policy and lockfile remain unchanged. Seven offline tests cover the XML CAS/backup preparer. Strict TS and package-local ESLint pass; an attempted root ESLint binary lookup failed and is preserved separately.

The APK has the owned host certificate, no shared UID and no OAuth callback scheme. KeyManager, signed registration, SDK identity mode and canonical pin parser remain real. Debug instrumentation reads only aliases and three file hashes. Metro17969 uses public nativeIdentity registration against API17960/IdP17961. Candidate SDK source1e719 is not final published package acceptance.

Commands: frozen Bun install; Gradle :oxy-identity-host:testDebugUnitTest :app:assembleDebug with x86_64 and dev port17969; :app:dependencyInsight --dependency bcprov --configuration debugRuntimeClasspath; node ../../node_modules/typescript/bin/tsc --noEmit -p acceptance/tsconfig.json; node node_modules/eslint/bin/eslint.js scoped to fixture and entry/config; python3 -m unittest discover -s packages/commons/acceptance -p test_prepare_corrupt_slot.py. Gradle ran from Commons/android; TS/lint from Commons. Logs retain RED and GREEN separately.
