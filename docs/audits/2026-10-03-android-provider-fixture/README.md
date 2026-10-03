# Android native provider fixture preparation

Source `9c7168095d96efe1dc4b925d850a728d4d1561b8` builds three disposable APKs from the reusable harness in `scripts/rehearsal/android-device-session`. Initial and final builds succeed; the final builder verifies the Gradle distribution, three APK signatures/manifests, and four copied real SDK Kotlin sources. `apk-proof.json` supplies local paths, hashes and certificate hashes for root review. Build executed Java21, bytecode target17, Android36; no adb was invoked.

Root alone operates the reserved disposable AVD emulator-5580 after review. Instrumentation has not run yet; expected phases begin/foreign/finish report5/4/8 checks, distinct real UIDs, and must refuse a preexisting slot. This is native shared-session-slot primitive evidence, not backend account switching/logout, OAuth/SSO or adoption of a published SDK.
