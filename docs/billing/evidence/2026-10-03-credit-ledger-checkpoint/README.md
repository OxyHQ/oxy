# Credit ledger and migration 0138 checkpoint

Source: `a5fe8f4d4` then `b2b3ae7ba`, with auth migration 0137 between them. Integrators cherry-pick the two billing commits without repeating auth 0137. Migration 0138 is frozen; no further billing DDL is planned for the catalogue/shared transaction delta.

The owned PostgreSQL reproduction at exact `b2b3ae7ba` passed **8 suites / 143 tests**. It supplies the detailed stdout lost when the original harness fixed output path was overwritten by WIP. The preserved original run has the command and exit 0; it is not represented as the reproduced stdout. PostgreSQL was freshly initialized, process/data/socket ownership was checked before database creation, and the process stopped after testing. No production access occurred.

The strict API TypeScript and scoped Biome records belong to the original checkpoint. Generation is generated Drizzle metadata, with immutable-history triggers appended from schema source; a second generation reported no changes. The rejected stale-contracts generation is retained to explain why contracts were rebuilt before the accepted generation. No snapshot was hand edited.

The checkpoint implements tracked grant FIFO, immutable spend/refund identities, retained-history deletion holds, cumulative proportional refund of only unconsumed credits, reserved-base period caps and paid historic upgrade attribution. Promotion registry remains empty. Refund support requires one fully allocated charge; partial/split payment ambiguity rejects. Paginated double reads do not prove an atomic remote snapshot. No opaque balance reconstruction or inference-money-to-credit conversion is present.

This evidence **does not cover** the later catalogue, shared award transaction, SDK, Console or backfill WIP. I06 and I07 remain open. See `proof.json` for exact source, installed dependency bytes and output hashes.
