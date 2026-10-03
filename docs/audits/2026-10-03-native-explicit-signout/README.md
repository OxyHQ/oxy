# Native explicit sign-out checkpoint

Source `945c8adf04ce93b0a4a487c26c6c78f09efe26ff` prevents an ordinary native account holder from silently performing a new Commons key sign-in after explicit final logout. The durable marker survives generic save/clear and process recreation; a successful explicit session commit may release it. Partial logout leaves recovery unchanged, and identity mode preserves its pinned-key contract. Native persistence operations serialize pending save and later clear. Marker failure after actual revocation cleans local state and reports failure.

Root captured actual Android signout followed by cold-start challenge/verify and renewed authentication. The copied endpoint-only log contains no headers, bodies or tokens. Its initial empty interface observer was not negative evidence. Local frozen harness fails three cases before the fix and passes the same three afterwards. Expanded suites pass 148 core and 40 Services tests; both package builds pass. Proof hashes identify source, records and rebuilt JS/types.

This is a candidate checkpoint. Android rerun, published-package repetition and final adoption remain pending. Historical incomplete-mock, old-expectation, Services regression and full formatter/import-check failures are retained and distinguished from terminal results. Scoped Biome lint used the existing source style without mass reformatting.
