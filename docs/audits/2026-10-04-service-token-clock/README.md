# Service-token boundary clock

The parameter table previously captured expiry/issued-at at module registration while token creation and verification read a later clock. A one-second boundary could make the intended invalid claim valid. Tests now freeze one instant for the table, mint and verification, and restore mocks after every case. Runtime verification is unchanged.

The CI failure and controlled delayed reproduction are retained in proof.json. The corrected canonical package test passes22 controls with owned PostgreSQL.
