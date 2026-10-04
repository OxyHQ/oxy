# Private Expo CLI self-reference repair

Accounts deployment37229132670 failed at main0c6: the renamed private CLI tried to resolve its own assets through `@expo/cli`, an alias absent inside its isolated installed package. Canonical local `accounts` build reproduces the exact failure. After fixing the first lookup, a real export exposed its separate Metro polyfill lookup; both failures remain preserved.

Private CLI57.0.23+oxy.native.3 resolves seven own asset/module/template lookups relative to its own installed files. The project's preferred template lookup stays unchanged. The explicitly identified upstream57.0.23 remains unchanged; the closed archive verifier admits exactly these replacements and removes their stale source maps. The immutable0.1.1 native signing adapter is preserved. Native.2 is a local intermediate failure, retained externally and never activated/published.

Manifest override and Bun lock point to the new immutable archive, with matching SHA512. Frozen reinstall plus full installed CLI/adapter member verification pass. No Forge is in the lock or API/CLI resolution. Published SDK package trees remain identical to main0c6; no private file reference enters their manifests. CI now runs the isolated self-reference controls alongside existing sealed-archive and native crypto checks.

Real Accounts export:7/7 builds,0 cache,37 HTML pages and headers. Accounts149 Jest tests/18 suites plus edge tests pass; native36, installed Expo14, archive9, self-reference3 and image-inventory6 controls pass. Original alias failure, intermediate polyfill failure and local setup errors are retained without treating them as production diagnoses. The RED test harness preceded formatting; no frozen byte-identity claim is made.

No AWS, source push, publication or deployment was performed. Root reviews this source/proof and promotes separately after core4.4 publication acceptance.
