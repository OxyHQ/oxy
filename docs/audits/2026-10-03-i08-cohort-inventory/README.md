# Exact cohort namespace inventory

Read-only production SQL snapshots authorized and independently verified by root.
Mercaria TD59/imagef5a2:2 active stores and2 current owners. One store has the
application owner as its owner; neither is automatically classified as a test
store. Peable TD7/imagea1d8:0 merchants for exact application6a37d0cc5d4b5f15482a9340.
Oxy's separate0439 inventory contains only3 production Mercaria credentials
(1service,2public), no test credential. No merchant, offer, price, binding or
consent was created by this inventory; no cohort is enabled.

Mercaria taskba631d0b exited0; TDoxy-billing-inventory-mercaria-cohort:1 INACTIVE.
Initial Peable taske9b66e23 failed before process start because Node is absent
from its Bun image; no SQL result exists for that attempt. Cleanup verified
STOPPED and definitionINACTIVE. This is retained as failure, never interpreted0.

Retry source014e5a97c uses exact deployed Bun with --no-env-file -e, no task role,
no extra environment and only existing DATABASE_URL SSM reference. Reader resolves
the installed postgres callable export (NodeCJS or BunESMdefault); SQL remains
repeatable-read/read-only, projection whitelist, timeout and bounded output.
Bun receiver was reproduced locally (ESMnamespace initial failure retained),
then13 SQL/receiver +7 launcher controls passed. Its own local PG5575 test DB
was dropped after every attempt; persistent server retained. Root-level initial
receiver attempt failed dependency resolution; correct cwd is packages/api.

Peable retry task7efc6041 exited0 with exacta1d8 image; TDinventory-peable-cohort:2
INACTIVE, cleanup0fail. Result complete merchants0, not missing/schema_mismatch.
Root independently verified AWS task/definition/digest/noTaskRole/oneDBsecret and
canonical result hashes31cb40b...Mercaria and298773a1...Peable. Raw rows and plans
remain private; proof commits their byte hashes, public receipts give counts.

The zero merchant can be a missing technical namespace: normal
POST/v1/merchants accepts an empty card-only body, derives app/environment from
its authenticated service token and creates no Stripe object, xpub, secret,
terms or price. A reviewed registration/readback can initialize this mapping
within existing authority; it does not imply commercial cohort activation.
Software adoption continues independently. Exact deployed Stripe account/mode
and approved store routing must still be verified before any cutover.
