# Measurement traps: checks that run clean while measuring the wrong thing

> Three mechanisms, each of which produced a confident wrong answer during the
> #972 wave. They share a shape: **the check runs, exits 0, and reports about
> something other than what the author believed** — so nothing looks broken, and
> the cost is paid later by whoever trusts the report.
>
> The compressed rules live in `AGENTS.md`. This is the evidence behind them and
> the reproduction for each.

## `origin/main..HEAD` after a fetch is not a statement about your commit

**To see what your own commit contains, use `git show --stat HEAD` or
`git diff HEAD~1..HEAD`. Never `git diff origin/main..HEAD`.**

`git diff A..B` is a TREE comparison, not a list of your changes. Once your
branch and `origin/main` have diverged — which a `git fetch` can cause at any
moment, without touching your working tree — that comparison also reports
upstream's commits, attributed as though they were yours.

Reproduction, in a throwaway repository:

```console
$ git show --stat --oneline HEAD          # the honest form
c8926a7 my commit
 MY_FILE.txt | 1 +
 1 file changed, 1 insertion(+)

$ git diff master..HEAD --name-only       # the trap
MY_FILE.txt
UPSTREAM_ONLY.txt                         # my commit never touched this
```

**The failure mode is misattribution, in both directions.** It cost time twice
in one wave, in two different disguises:

- A scoped diff run against a stale base looked *contaminated* — as though the
  branch carried a sibling's work — and an overlap check built on it reported
  twelve files that did not overlap at all. The check ran and exited 0; it was
  comparing against the wrong base.
- After a rebase and a later fetch, `git diff --name-only origin/main..HEAD`
  listed `bun.lock` and `packages/contracts/package.json`. It read exactly like
  a contracts release had been swept into a four-file Console commit. Nothing
  had: `origin/main` had moved to include that release between the rebase and
  the command, and the diff was showing *upstream's* files inverted.

The second reading is the dangerous one, because "I have accidentally committed
someone else's files" is plausible, alarming, and sends you looking at your own
commit instead of at the command.

**Whenever a diff surprises you, ask what it is being compared AGAINST before
concluding anything about what it contains.** A `git fetch` between two commands
is enough to change the answer with no local change at all.

## `git checkout --theirs` during a REBASE takes the commit being applied

**During a rebase, `--ours` is upstream and `--theirs` is your own commit — the
inverse of what both words mean during a merge.** To take upstream's version of
a file, name it explicitly: `git checkout origin/main -- <path>`, then verify
byte identity against upstream rather than assuming the checkout did what the
word implied.

A rebase replays your commits ON TOP OF upstream, so upstream is the checked-out
side ("ours") and each replayed commit is the incoming side ("theirs"). The
words are consistent with the mechanism and inverted with respect to intent.

Reproduction:

```console
$ git rebase master            # master has UPSTREAM-CHANGED, my commit has MINE
CONFLICT (content): Merge conflict in f.txt

$ git checkout --theirs f.txt && cat f.txt
MINE                           # the commit being applied, NOT upstream
```

**The failure mode is a silently reverted generated artifact.** Two agents hit
this on `packages/api/drizzle/meta/*_snapshot.json`, and the symptom pointed
away from the cause: one briefly had its own pre-#1030 snapshot in place of
main's, so `drizzle-kit generate` prompted for a table rename nobody had made
and the snapshot gate looked as though `main` itself were broken. A snapshot is
exactly the kind of file this hides in — nobody reads it, it is regenerated
rather than authored, and a stale one is indistinguishable from a current one
until a tool draws a conclusion from it.

Found and independently confirmed by `w5a-security-controls` and `w2-cred`.

## A transforming query schema must parse its own output

**In this API a request query schema is parsed TWICE, so any schema that
transforms a value must also accept the value it produces.** Express the input
and the output form as a union, and assert idempotence in a test.

`middleware/validate.ts:30` writes its parsed result back onto the request:

```ts
req.query = schemas.query.parse(req.query);
```

and each handler parses again to obtain a typed value
(`routes/costCenters.ts:117`). So a schema that turns `'true' | 'false'` into a
boolean is handed its own boolean on the second pass. A string-only schema
rejects it.

The corrected shape accepts both positions:

```ts
includeRetired: z
  .union([z.enum(['true', 'false']).transform((value) => value === 'true'), z.boolean()])
  .default(false),
```

**The failure mode is a 500 on a read, outside any validation boundary.** The
second parse happens in the handler, after `validate` has already passed, so the
`invalid_type` is not shaped into a 400 — it escapes as an unhandled error.
`GET /billing/cost-centers` answered 500 on **every** request, including the
default one with no parameters at all, for as long as the route existed. It
survived review because the schema is correct in isolation and the middleware is
correct in isolation; only the composition is wrong.

It also survived because **no test had ever called that route**. A schema unit
test that parses `{ includeRetired: 'true' }` once passes against the broken
version, which is why the regression guard asserts the round trip instead:

```ts
it('parses its own output, in both positions', () => {
  for (const input of [{}, { includeRetired: 'true' }, { includeRetired: 'false' }] as const) {
    const once = costCenterListQuery.parse(input);
    expect(costCenterListQuery.parse(once)).toEqual(once);
  }
});
```

Found by `w5a-security-controls`.

Two adjacent notes, since the same composition invites them:

- `z.coerce.boolean()` is not the fix. It makes `'no'`, `'0'`, `'FALSE'` and any
  other non-empty string `true`, so it converts a rejected typo into a silently
  wrong filter.
- A `.strict()` schema whose transform ADDS a key it does not declare fails the
  second parse with `unrecognized_keys`, for the same reason. Measured, so the
  boundary is exact: a `.default()` on a DECLARED key re-parses fine, because the
  key is in the shape; it is only a key the shape does not name that fails.
