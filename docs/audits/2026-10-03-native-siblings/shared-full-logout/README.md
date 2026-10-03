# Native siblings: shared full logout candidate

Both fixtures use exact core/contracts/services Git trees from reviewed `e5a44006aaa998494eac65ced581bbda83f8fd5e` (runtime ff7e60e6e). Mention head `1bdd81b94`, Allo head `a194e50a0`. Ports remain 17967 and 17968. Source, built artifacts, registry resolution and served bundles are frozen for root's device repetition.

The only fixture change adds `acceptance-profile-sequence`, initially zero. Read Profile invalidates the canonical `GET:/users/me` cache entry, awaits `users.me()`, then increments functionally on success. Failures do not increment; root still observes the actual HTTP call. No auth refresh, token, identity store or key operation was added. The earlier counter-only preparation is retained separately and was not accepted as a fresh HTTP read.

Both core/dependency and Services builds pass. The identical core source was tested once here: 3 suites / 16 tests pass. Upstream's full reviewed evidence remains separate; no full suite repetition is claimed. Installed core resolves workspace telemetry 1.2.0. All four root/app Bloom 6.2.1 resolutions match all 20,940 registry tarball files. No dependency installation or APK rebuild was required.

Each Metro runs with CI=1, EXPO_NO_DOTENV=1, EXPO_NO_TELEMETRY=1, the existing public fixture client ID and sibling variant, localhost and its existing port, with an owned TMPDIR cache. After the final entry edit, both owned Metros were restarted; capture asserts the served readProfile contains cache invalidation before the awaited call and counter. Actual manifest launch URLs and full non-lazy textual bundles are recorded separately, not conflated. The capture script and immutable Metro log snapshots are included.

The preparer made no ADB calls and changed no API17960, IdP, PG data, registration, Android package/certificate or identity stores. Root will check sibling running and stopped across full logout, cold restart, explicit sign-in and shared organization resume. No device outcome or final registry Oxy adoption is asserted at this freeze.
