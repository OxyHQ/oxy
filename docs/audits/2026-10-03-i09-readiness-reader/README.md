# I09 read-only readiness preparation

The fixed reader selects the authorized three deployment IDs, model/revision,
referenced model and platform-fee price IDs and their unit prices, Alia app /
credential / workload ceilings, and provider feed cursor. It returns stored
facts and unknown/missing states; it performs no quote, mint, inference,
ingestion, grant, balance or credential mutation. No rate or cost is inferred
from provider labels. The test explicitly binds a platform fee whose provider
and model reference differ from the deployment.

The reader and ECS launcher reuse the reviewed I03 inventory transport. Deltas
are retained for comparison; nonce packet, readonly transaction and cleanup
mechanisms are unchanged. New tests exercise ten SQL/Node receiver cases on an
owned PostgreSQL process with literal fixture schema fragments (not normal full
migrations). The final process is stopped. AWS prepare/execute and actual
catalogue eligibility/readback remain root-operated and pending.

Prepare command from the pinned checkout:
`python3 scripts/inference/internal-pilot-readiness-ecs.py oxy --plan <new-private-plan.json>`.
Execution requires review of the resulting exact image/network/config/source
plan. No provider calls, service token or user delegation header are used.
