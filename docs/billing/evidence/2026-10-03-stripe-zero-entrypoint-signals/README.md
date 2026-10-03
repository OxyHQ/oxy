# Local receiver entrypoint: signal and dotenv boundary

Source5b08680c7 reuses the reviewed SignalCoordinator around migration and receiver
children. The coordinator owns each process group, forwards the first signal,
waits up to30seconds for this offline child, records forced termination, and
restores handlers only after the owned database finally completes.

Three black-box tests run the actual copied Python entrypoint with real owned PG
and real Bun children. Only migration/event bodies are fixtures. Normal exit,
SIGTERM to the parent and SIGINT to its group pass. Both signal cases observe
child cleanup with PostgreSQL still alive, followed by childStopped before PG
shutdown. Dotenv and inherited credentials stay absent in all three migration
bodies and the receiver; fixed BUN_OPTIONS and explicit flags remain effective.
This does not prove remote provider cleanup or SQL migrations in those fixtures.

A separate actual receiver run migrates fresh140/repeat, then replays the same
previously captured own event and original payer/customer in a new test:test DB.
It passes500 diagnostic →200/replay200, one not_granted receipt/three attempts,
zero grants/balance/provider requests. All four own PostgreSQL PIDs are stopped.

Commands: `python3 -B scripts/billing/test-stripe-zero-isolation.py` (3passed),
`python3 -B scripts/billing/test-stripe-zero-receiver.py <private-own-run-directory>`
(actual local receiver exit0). Logs/hashes are in proof.json. No Stripe GET/create
is repeated, and the original failed remote receipt remains historical evidence.
