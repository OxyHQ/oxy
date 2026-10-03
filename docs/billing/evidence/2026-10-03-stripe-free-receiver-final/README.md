# Final free-invoice receiver harness delta

Source: `92ae0b11a3e2980390e38cefdd50b6b9b09b0df2`.

The real runner delivery now calls `assertAcceptedWebhookDelivery`; its local
HTTP 500 fixture checks the same helper produces only the bounded status/code.
The Python fixture preserves its fixed `BUN_OPTIONS=--no-env-file` in both
normal and sandbox environments and uses explicit flags for migration/receiver.

The final owned PostgreSQL run applies migration140 fresh and repeat, then uses
a separate new physically marked test database for the actual captured event.
Invalid paid catalogue returns500. A valid catalogue without a paid mapping
returns200; replay also returns200, with one not_granted receipt (three attempts)
and no credit/access grants, transactions or balance. PID3637835 was stopped.
No provider request or mutation occurs during this reproduction.

Commands and logs:

- `python3 -B scripts/billing/test-stripe-zero-receiver.py <private-own-run-directory>`: exit0, local-receiver.log.
- `bun --no-env-file x tsc -p packages/api/tsconfig.scripts.json --noEmit`: exit0, scripts-ts.log (same TS source bytes at8a9730).
- `bunx @biomejs/biome@1.9.4 check --error-on-warnings packages/api/scripts/stripe-billing-sandbox-rehearsal.ts`: exit0, biome.log (same TS source bytes at8a9730).

The original remote attempt remains failed. Its actual event was previously
retrieved read-only; this fixture uses a locally generated signature and does
not claim public provider delivery. Earlier source/proof remain inspectable in
`../2026-10-03-stripe-free-invoice/`. No repeat provider objects are created.
