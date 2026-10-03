# Empty paid bundle maintenance — 2026-10-03

Source `12d8cbb86` preserves the existing empty bundle contract. Named cancellation and subscription lifecycle require paid-period evidence linked to the exact source, provider, account, mode, environment, subscription and parties. They do not require an access grant.

The real Postgres and HTTP fixture creates a paid product-only empty bundle with concordant catalogue and DB configuration, lists it, cancels it once, then delivers fresh lifecycle and replay events. It retains one segment, no access grants, no subscription credit grants and no paid credits. The focused group passes 11 suites / 177 tests. Provider calls are synthetic; this does not establish a real Stripe sandbox cycle.

The harness initialized and verified its own Postgres process (PID 3475630), data directory and sockets before database creation, and stopped it afterward. Source and logs are bound in proof.json. Sandbox fencing is a later change and was not part of this run. I06/I07 remain open pending their complete acceptance.
