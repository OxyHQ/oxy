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
import { calendarDaysBetween } from '@oxy.so/utils/date';
import { withImageVariant }    from '@oxy.so/utils/image';
import { formatMoney }         from '@oxy.so/utils/currency';
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

### `./date` — calendar-day arithmetic

`calendarDaysBetween(from, to)`: whole LOCAL calendar days, `0` same day, `1`
next, `-1` previous, time of day ignored.

The "Today / Yesterday / this week" bucketing is hand-written in **six repos**
as `(startOfDay(a) - startOfDay(b)) / 86400000`. Two (Inbox ×4, oxy's accounts
activity list) round it with `Math.floor`, which is wrong across a
spring-forward night: midnight-to-midnight is 23 hours, floors to `0`, and
yesterday's mail files under "Today". This subtracts the date parts as UTC
dates, where every day is 24 hours. It answers *which calendar day*, not *how
much time elapsed* — elapsed-time labels (`"2d ago"`) stay where they are. An
invalid `Date` yields `NaN`, which fails every `=== 0` / `< 7` comparison.

### `./currency` — money text, minor units, injected-rate conversion

`formatMoney`, `formatMoneyRange`, `currencyName`, `isIsoCurrencyCode`,
`currencyDisplayDigits`, `currencyStorageDigits`, `toMinorUnits`,
`fromMinorUnits`, `convertAmount`, and `FAIR_CODE` / `FAIR_SYMBOL` /
`FAIR_DECIMALS`.

The one entry that did **not** arrive byte-identical. Six apps format money
(Homiio, Mercaria, Inbox, Moovo, Peable, GoWay) and they disagreed: symbol
placed by locale vs prefixed from a table, the unformattable-code fallback
amount-first vs code-first, FAIR stored at 8 decimals vs 2. Like
`calendarDaysBetween`, the disagreement is the reason it is shared — here it
was settled by a product ruling rather than by one side being a bug, which is
what satisfies clause 3:

- **Storage is not display.** FAIR (FairCoin, not ISO 4217, `⊜`) is stored at
  `FAIR_DECIMALS = 8` everywhere and displayed at 2. ISO currencies display
  with `Intl`'s digits (EUR/USD 2, JPY 0) and store at their ISO 4217
  exponent — a static table, because CLDR's display digits differ from ISO for
  a dozen codes and have moved between ICU releases, and a stored integer must
  mean the same amount on Node and on Hermes.
- **Locale-aware via `Intl`.** `€1,234.56` in `en`, `1.234,56 €` in `de`. The
  currency is the amount's own, never derived from the locale.
- **A code `Intl` cannot format** (FAIR, anything not three letters) renders
  amount, no-break space, code: `1.234,56 FAIR`. No symbol is invented.
- **Never throws** — a malformed locale, code or amount degrades to readable
  text. Minor-unit helpers return `null` rather than guess a precision or
  exceed `Number.MAX_SAFE_INTEGER` (≈ 90 million FAIR).

```ts
formatMoney(1234.56, 'EUR', 'en-US');                  // '€1,234.56'
formatMoney(1234.56, 'EUR', 'de-DE');                  // '1.234,56 €'
formatMoney(1234.5,  'JPY', 'ja-JP');                  // '￥1,235'
formatMoney(12.3456789, 'FAIR', 'en-US');              // '12.35 FAIR'
formatMoney(1700, 'EUR', 'en-US', { minimumFractionDigits: 0 }); // '€1,700'
formatMoneyRange(500, 1200, 'EUR', 'en-US');           // '€500.00–€1,200.00'
currencyName('EUR', 'es-ES');                          // 'euro'

toMinorUnits(1, 'FAIR');                               // 100_000_000
toMinorUnits(1.005, 'EUR');                            // 101 (the decimal typed, not 100.4999…)
fromMinorUnits(1250n, 'EUR');                          // 12.5 (ledger bigint accepted)

// Rates are fetched by the app and passed in; any base works.
convertAmount(100, 'EUR', 'USD', { base: 'FAIR', rates: { EUR: 0.5, USD: 0.55 } }); // ≈ 110
```

`convertAmount` returns the amount UNROUNDED (round once, where it is stored
or shown) and `null` when either side has no rate — never an assumed rate of 1.
`toMinorUnits` takes `{ rounding: 'halfEven' }` for FX-style rounding.
`es` does not group four-digit numbers (`1234,56 €`); that is CLDR's rule for
Spanish, not this module's.

Stays in the apps: fetching rates, the user's preferred currency, pickers and
flag lists, glyph components (`FAIR_SYMBOL` is exported for them), bidi
isolation, and product wording such as Homiio's per-month price labels.

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
