# Retiring an ephemeral catalogue registrar

Source `8f0aa227c`. A selected real PostgreSQL/HTTP fixture provisions a random service credential under the synthetic canonical registrar application, with only `catalogs:write` and five minutes of usability. Its secret is held locally in memory; only its SHA-256 is persisted. The actual `/auth/service-token` endpoint mints the Ed25519 token; the actual catalogue endpoint registers canonical Oxy bytes.

After SQL revocation preserves the credential row, catalogue discovery, requester approval/ticket and domain read remain valid. Both another registration with its previously minted token and another secret-based mint are refused. The registration retains its original credential FK and stays active. Finally revokes the credential again; no credential or catalogue history is deleted.

One selected test passes; 21 other cases are deliberately not repeated. Fresh normal 142 migration and repeat run on a new owned PG process. PID/executable/data/socket were verified before CREATE DATABASE. PostgreSQL processes 3796764 and 3797170 are stopped (see exact PIDs in proof). API TypeScript and Biome 1.9.4 exit 0. The initial setup used `.claims` instead of the existing verifier's `.payload`; ts-jest refused it before tests. That fixture error is retained without calling it a product RED reproduction.

This proves preservation across creator-credential revocation locally, not production configuration or adoption. AWS attestation/Redis transport are isolated by the existing fixture. No live authority, Stripe or AWS effects occurred. The accepted [CAS plan](../../../architecture/i05-foreground-pilot/cas-plan.md) is durable; its executor and operational negatives are still being implemented. No shared IAM role receives catalogue authority.
