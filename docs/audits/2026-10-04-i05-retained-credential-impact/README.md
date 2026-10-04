# Retained credential authority and expiry in I05 CAS

The full credential census preserves each row and now also rejects expansion of effective authority for a usable retained identity when the application ceiling changes. It uses the existing canonical scope intersection and credential lifecycle helpers. The three retained live identities previously accepted had no ticket scope and NULL expiry; the conditional findings were not observed in that operation.

Administrative PostgreSQL dates are compared as ISO strings in both apply and rollback. A genuine expiry change remains rejected. Five failures on the frozen source become 87 passing tests across four suites on the fixed source; the exact frozen regression fixture is retained. Compiled Node controls3, canonical migrations142 fresh/repeat, build, scripts types and scoped Biome1.9.4 pass. Owned PostgreSQL processes are gone.

No production task or authority mutation was run for this fix. The operational module can ship upstream without requiring a new served API deployment; Forge checkout provenance is independently revalidated before merging. Existing accepted live evidence retains its original source pins.
