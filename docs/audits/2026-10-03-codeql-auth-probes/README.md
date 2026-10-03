# Rate-limited identity fixture routes

Source `ea87ebcd464dbca7182d9f40fc6178d2d82953ea` applies the real express-rate-limit middleware before all three auth identity probe routes. This addresses CodeQL568/569 (`js/missing-rate-limiting`, high, classified test) on the simple and optional auth probes without suppressions or changes to authorization runtime. The limiter uses the existing hashed IP key helper and a fixture-local MemoryStore.

Two new HTTP cases each reset only that fixture store, pass100 authenticated requests and assert the101st is429 with no identity DTO. The existing identity assertions remain intact. Combined real PostgreSQL suites pass45 tests (27 service-switch plus18 identity). Fresh140 migrations and repeat pass; owned PID3637767 is stopped. Exact ESLint file check exits0.

Run `python3 scripts/rehearsal/test-service-switch-live-1519.py`. [Proof](proof.json) binds source and terminal records. CodeQL annotations remain recorded as open on main67c09 until a new analysis proves this candidate; local green tests alone do not clear that gate. No production or auth semantics changed.
