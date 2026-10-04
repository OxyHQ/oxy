# Commissioning composed with accepted machine backend

PR1580 now contains accepted main0c6 and the isolated Alia resource test fixture. Every changed API/script path maps byte-for-byte to the prior reviewed commissioning source, accepted main or the independently tested machine/private composition. The fixture regression uses its own PostgreSQL database and preserves foreign rows; the original collision and117passing checks are retained.

This is source composition evidence. It does not activate Jev, the source getter, Mention approval, legal review or a provider request. Prior commissioning build/SQL evidence is preserved. PR and merge CI qualify this exact composition before deployment; Mention-specific changes remain separate in1578.
