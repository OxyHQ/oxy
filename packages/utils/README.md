# @oxy.so/utils

Dependency-free helpers shared across every Oxy service.

## What belongs here

A helper earns a place only if it is **all three** of:

1. copied byte-identically into **three or more repos**,
2. pure and dependency-free,
3. something no repo could reasonably want a different version of.

The third clause does most of the work. An audit of eight Oxy repos found
plenty of duplication that fails it and is deliberately **not** here:

| Candidate | Repos | Why not |
|---|---|---|
| Query-param coercion | 3 | All three chose *contradictory* semantics for a repeated parameter — absent (Mention), last wins (oxy), first wins (Homiio) — and each documents its choice as the fix for a real incident. One shared version would overrule two of them. |
| Retry / backoff | 5 | Six different policies. A retry budget is a decision about a specific dependency. |
| Compact number / duration formatting | 4 | Four different outputs (`1.2K` vs `482.8k`). Unifying them is a design change. |
| `sleep` / `delay` | 4 | Six of seven copies leak a timer on cancellation. Sharing would enshrine the bug; the good one is `AbortSignal`-aware and belongs with the HTTP client. |

The ecosystem also has a binding precedent for leaving small things duplicated:
ADR 0022 keeps per-app i18n rather than sharing one catalogue, because the
shared version would carry the wrong weight. A utility that has to be
*configured into agreement* is that case.

## Exports

Nominal, following `@oxy.so/core`: no `export *`, no barrels. Subpaths exist
because two consumers' bundle gates refuse root-barrel imports — Metro does not
tree-shake, so a frontend importing one function must reach it without dragging
the rest in.

```ts
import { likeContains }      from '@oxy.so/utils/sql';
import { resolvePageLimit }  from '@oxy.so/utils/paging';
import { escapeRegExp }      from '@oxy.so/utils/text';
```

### `./sql` — LIKE pattern building

`escapeLikePattern`, `likeContains`, `likeStartsWith`, `likeEndsWith`.

Found **ten times in six repos**, six byte-identical, with **one test between
all six**. The escaping is the security-relevant half: a term reaching `LIKE`
unescaped means `100%` matches every row, and nothing in the response says the
filter was ignored. This does **not** defend against injection — the term is
always a bound parameter — only against the caller's text being read as a
pattern.

### `./paging` — page-window resolution

`resolvePageLimit`, `resolvePageOffset`, `resolvePageNumber`, `offsetForPage`.

Seven helpers in five repos plus **46 inline clamps**, none agreeing on
degenerate input. The guarantee: no input — missing, malformed or hostile —
yields an unbounded query or a `NaN`. Bounds are arguments, not a registry: a
lane's page size belongs next to the lane.

### `./text` — small pure helpers

`escapeRegExp` (16 byte-identical copies across four repos), `clamp` (with the
`NaN` guard two of three copies had), `chunk`.

## Consuming it

Inside this monorepo, `workspace:`. From another repo, the published semver
range — and note that a repo with no prior `@oxy.so/utils` dependency needs it
added to its manifest and its lockfile regenerated; `--frozen-lockfile` does not
catch a manifest/lock desync on its own.

## Commands

```bash
bun run test        # never a bare `bun test`
bun run typescript
bun run lint
bun run build
```
