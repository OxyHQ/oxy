# Bootstrap the Kaana catalogue reviewer

The catalogue bootstrap refuses unless its exact reviewer is both staff and has
`inference:catalogue:publish`. Production currently has no such account. Use
this one-purpose command before `bootstrap:kaana-catalogue`; never update a row
by username, display name, ordering or a partial match.

The measured production target on 2026-09-03 is exact `users.id`
`6981c9178fcdefaf81988ffb`. Re-read that row by ID before applying. A dry run is
the default and performs no write:

```bash
STAFF_BOOTSTRAP_USER_ID=6981c9178fcdefaf81988ffb \
  bun run --cwd packages/api bootstrap:catalogue-reviewer
```

Review the printed previous/next state. Apply only from a reviewed production
task with an attributable operator and change reason:

```bash
APPLY=1 \
STAFF_BOOTSTRAP_USER_ID=6981c9178fcdefaf81988ffb \
STAFF_BOOTSTRAP_ACTOR='<operator-or-automation-id>' \
STAFF_BOOTSTRAP_REASON='<approved-change-id-and-reason>' \
  bun run --cwd packages/api bootstrap:catalogue-reviewer
```

The transaction locks and updates only that exact row, preserves existing staff
capabilities, adds only `inference:catalogue:publish`, and inserts a high-severity
`security_activities` audit event carrying the previous and next state, actor
and reason. Re-running after success is idempotent (`changed: false`) and writes
nothing. An unknown, empty, whitespace-normalized or oversized ID fails closed.

After application, verify the exact row and its new audit event before supplying
the same ID as `KAANA_CATALOGUE_REVIEWER_USER_ID` to the catalogue bootstrap.
Do not run either apply command from an unreviewed branch.
