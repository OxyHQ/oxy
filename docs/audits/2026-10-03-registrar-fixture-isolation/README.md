# Registrar fixture isolation

CI37146494447 failed three configuration tests because the preceding foreground capability suite left independent `catalog:oxy` applications in its worker database. The production precondition correctly inventories all registrars. The ordered real PostgreSQL reproduction preserved that failure (23 passing/3 failing); the same runner and sequencer pass all26 after the configuration suite creates its own normally migrated database and drops it in teardown. Production code and global assertions are unchanged.

The frozen RED, terminal logs, normal142 fresh/repeat migrations, three compiled Node controls, source hashes and stopped PostgreSQL processes are recorded in proof.json. Complete CI and ARM/policy provenance for the new freeze remain pending.
