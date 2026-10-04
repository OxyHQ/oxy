# Stable pilot claim snapshots

Queue #1577 failed only the commercial-rights denial snapshot comparison: the same metered claim IDs returned in a different SQL result order. The preceding HTTP503 and zero-execution assertions passed. The preserved CI excerpt records the failure; the full original log hash is in proof.json.

The helper now orders by the unique claim ID. It still compares every returned row and detects any added or removed claim; no membership, cardinality, denial, quote or execution assertion was removed. This changes one test helper and no runtime or policy source.

The existing real HTTP/Postgres and economic-policy suites pass: 65 tests in two suites. They use an owned loopback PostgreSQL instance, canonical migrations and the existing fake Kaana data plane. PostgreSQL was stopped. The initial missing-zod setup failure is retained separately and is not treated as a product regression.

Source and validation records: [proof.json](proof.json). No AWS, inference provider calls, publication, push or production operations were performed.
