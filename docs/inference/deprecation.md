# Deprecation and sunset policy

#972 asks for "explicit deprecation and sunset dates before removing
compatibility paths". **This page publishes no date, because there is none to
publish and inventing one would be worse than omitting it.** What it does
publish is the policy a date will be issued under — **adopted 2026-08-17, and
binding** — and the list of things that will need one.

Status of the whole platform: [README.md](./README.md).

---

## Why there is no date yet

Two facts, both checkable:

1. **Nothing an external developer can reach has been deprecated.** The things
   retired so far were retired because they never did anything — see
   [what has been retired](#what-has-been-retired-and-why-none-of-it-needed-a-date).
   A name nothing checked has no users to give notice to.
2. **A sunset date is meaningless before a launch date.** The public inference
   edge exists and refuses every invoke for want of a data plane, so no external
   developer depends on it. The first real deprecation notice is owed when the
   first thing anybody depends on ships, and it is owed by whoever ships it.

A date written now would be a date chosen without knowing the launch it is
relative to, published to an audience of nobody, and stale before it applied.

---

## The policy

**Adopted 2026-08-17** by the owner, as written. It is expressed in windows
relative to events rather than calendar dates, which is what let it be adopted
before there is a launch for a date to be relative to — and is why adopting it
publishes no date and invents none.

Adopted means binding: the windows below are the minimum notice a removal owes,
and a removal that cannot show its notice is not ready to merge.

### What a deprecation notice must carry

A notice is not the word "deprecated" in a changelog. It carries, all five:

1. **What is being removed**, named precisely enough to grep for — an endpoint
   path, a field name, a scope string, a credential prefix.
2. **What replaces it**, or an explicit statement that nothing does and why.
3. **The sunset date**, absolute, in UTC.
4. **How a caller finds out whether they are affected** — the concrete query,
   log line, header or Console screen that answers it.
5. **Who was told, and how.** A notice addressed to a knowable set of
   applications is delivered to them; one addressed to the world is published.

### Minimum notice windows

| The path being removed | Minimum notice |
|---|---|
| A public endpoint, request field, response field or error code anything can reach | **180 days** |
| A scope, credential type or authentication lane | **180 days**, plus a per-application notice to every application holding it |
| A compatibility path whose consumer set is knowable and small | **90 days**, addressed to those consumers by name |
| Something with zero consumers, proven by a query against production rather than by a grep | **immediate**, with the proof recorded in the removal's own commit message |

The last row is the one that gets abused, so it carries its own rule: "nothing
uses it" is a claim about production, and a repository search is not evidence
for it. State the query, state the count, state the date it was run.

### Two things a notice never does

- **It never shortens itself because the change is small.** A one-field removal
  and an endpoint removal break a caller identically.
- **It never removes the old thing and the new thing in one release.** A caller
  needs a window in which both work, or the notice is a migration they cannot
  perform.

### Where a live deprecation is recorded

- **A model**: `deprecation` on its catalogue entry, carrying the status and the
  replacement to migrate to. An `active` model has no sunset date, because the
  deprecation must be announced first.
- **An endpoint, scope or credential type**: this page, plus
  [migration.md](./migration.md), plus the notice itself.

---

## What has been retired, and why none of it needed a date

Recorded because "we removed it without notice" is the kind of claim that should
have to defend itself.

| Retired | Why no notice was owed |
|---|---|
| The `chat:completions` and `models:read` scopes | Neither ever authorised anything: no middleware, route or service read either one. They were a vocabulary entry an application could hold and a permission nothing checked. Stored rows were rewritten to their successors by migration, including consent grants, so no user was re-prompted |
| `oxy_dk_…` as a bearer token | It never worked. The documentation was wrong, not the behaviour — a public client id resolves against a column it is not in |
| `alia-lite`, `alia-v1`, `alia-v1-pro`, `alia-v1-pro-max` as model ids | None of the four ever identified a model. They were product tiers a proxy forwarded to Alia, where something else decided what ran. An alias would have preserved exactly the ambiguity being removed |
| The static `models-stats` catalogue | Its four entries were the same product tiers, with literal statistics (`uptime: 100`, `isHealthy: true`). The URL survives and now serves real catalogue data |

Detail on each: [migration.md](./migration.md).

---

## The Alia proxy retirement is complete

The caller census found that the Oxy proxy was an internal compatibility path,
not a public API with independent consumers. Its point-inference callers were
moved to authenticated Oxy endpoints backed by Kaana; legitimate Alia agent,
chat and voice product callers remain direct Alia integrations.

Oxy no longer mounts `/alia/*` or the legacy `/v1/voice/*` fallthrough and no
runtime configuration requires `ALIA_API_KEY`. Negative route tests keep these
paths closed so the shared-key proxy cannot reappear accidentally. The earlier
notice plan is retained in Git history; there is no active notice clock.

### The `developer_api_keys` table — REMOVED

An Oxy legacy table with no reader and no writer left in this package, and one
stale foreign key pointing at it from `api_key_usage_events.api_key_id`. It was
never a supported way to authenticate and was not the same thing as an
Alia-issued `alia_sk_…` key.

**Notice owed:** none to customers — it authenticated nothing. It was the
"immediate, with proof" row, and the proof was a row count against production
rather than a grep.

**Removed** by #972 workstream 2.3 in
`packages/api/drizzle/0047_retire_developer_api_keys.sql`, which drops the
`api_key_id` column and then the table. The migration is `post`-phase, so it
applies only once the image that no longer declares either is live.

The row count came first and gated the merge, which was the whole point of this
row: a grep could not settle it. **Measured 2026-08-17 against production**, with
read-only queries from a one-shot Fargate task on the live `oxy-oxy-api:201` task
definition — `developer_api_keys` 0 rows, `api_key_usage_events` 0 rows, 0 of them
with a non-null `api_key_id`. Beside controls, because a bare zero is not
evidence: 69,432 users, 31 applications, 34 application_credentials, 153 public
tables, 46 of 46 migrations applied. Nothing needed migrating.

`api_key_usage_events` itself SURVIVES: it is general API telemetry, it has two
live readers (`routes/applications.ts`, `routes/credits.ts`), and its retirement
is not part of this.

### The public edge itself, once it serves a request

Everything on `/v1` is provisional until the first real completion is served,
and this section is the place to say so plainly: **a shape nobody has ever
exercised is not yet a compatibility promise.** The windows above start applying
to `/v1` when the first external developer can get a completion out of it, and
that transition should be announced in its own right.

### `stream` on a request body

The edge accepts the field and refuses `stream: true`. When streaming ships,
that refusal disappears — an addition, not a removal, so no notice is owed. It
is listed here only because the SDK's request type deliberately omits the field,
and the exemption is removed in the same change that adds streaming.

---

## If you are reading this because you were told something is being removed

Ask for the five items in [what a deprecation notice must carry](#what-a-deprecation-notice-must-carry).
A notice missing the sunset date or the "how do I know if I am affected" step is
not a notice, and this page is the thing to point at.
