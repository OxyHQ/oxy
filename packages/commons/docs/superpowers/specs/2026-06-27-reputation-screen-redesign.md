# Commons Reputation screen redesign — "engine room"

Date: 2026-06-27
Package: `packages/commons`
Screen: `app/(tabs)/(reputation)/index.tsx`

## Problem

The original Reputation screen was a flat settings-style list built from the
generic `AccountCard` / `Section` / `GroupedSection` scaffolding: a big bare
number, a "validator inbox" buried as a list row, and verbose `CivicBadge`
weight rows. It read like a form, not like a status surface, and the lifetime
total (the least actionable figure) was the loudest element.

## Approach

A single prioritized vertical scroll of purpose-built, Bloom-themed
(`useColors`), rounded-28 surfaces. The `ScreenHeader` title/subtitle is removed
(the tab already says "Reputation", mirroring the decluttered ID screen). Order
top → bottom:

1. **Standing hero** (`components/reputation/StandingHero.tsx`) — the trust TIER
   is the headline (tier colour + shield), not the raw number. A progress bar to
   the next tier with `"47 → 100 · 53 to Trusted"` copy; `verified` renders a
   "max / verified human" state and `high_trust` a "top earned tier" state, both
   without a bar; `restricted` is a punitive state. Two explained stat chips —
   Influence (`×1.4`, the capped `influence.defaultWeight`) and Reliability
   (`90%`, `reliability.reportAccuracyScore`). The lifetime total is quiet
   secondary text. Offline chip when `useCivicProfileState` reports offline.
2. **Composition** (`components/reputation/CompositionCard.tsx` +
   `ReputationDonut.tsx`) — a Skia donut of the POSITIVE sources (real-life /
   peer-civic / apps); penalties are broken out below the ring, never in the
   proportion. Legend rows carry a compact HIGH / MED / LOW / PEN weight tag in
   place of the verbose `CivicBadge` rows. The existing `SOURCE_ICON` mapping is
   preserved.
3. **Civic duty** (`components/reputation/CivicDutyCard.tsx`) — a distinct
   accent-tinted/bordered call to action (not a buried row) with the pending
   validation count badge, opening `/(tabs)/(reputation)/validate`.
4. **Recent activity** (`components/reputation/ActivityList.tsx` +
   `ActivityRow.tsx`) — up to 8 recent ledger entries: category icon, human
   label (`+25 Real-life confirmation`, `-10 Incorrect verdict`), relative time,
   and an Oxy-signed/verifiable shield for crypto-attested actions. Loading,
   error, and empty states preserved.

## Data

- `useCivicReputation(userId)` → `ReputationBalance` (canonical total, breakdown,
  trustTier, capped `influence`, `reliability`).
- `useReputationSources(balance)` → 4 derived sources via
  `deriveReputationSources` (unchanged).
- **New** `hooks/useReputationActivity.ts` → recent `ReputationTransaction[]` via
  `oxyServices.getReputationTransactions(userId, 8)` — offline-first,
  `civic`-namespaced React Query, mirroring `useCivicReputation`.
- `useValidatorInbox()` → pending validation count.

## Derivations (pure, unit-tested)

- `lib/civic/reputation-standing.ts` — `getTierProgress(tier, total)` reads the
  point thresholds (`TRUST_TIER_TRUSTED_MIN = 100`,
  `TRUST_TIER_HIGH_TRUST_MIN = 500`) **mirrored** from the server source of truth
  `packages/api/src/utils/reputation.constants.ts` (commons cannot import
  `@oxy.so/api`; same mirror pattern as `card-presentation.ts` /
  `reputation-sources.ts`). `verified` = personhood (max, no bar); `restricted` =
  punitive. Plus `formatInfluenceMultiplier` / `formatReliabilityPercent`.
- `lib/civic/reputation-activity.ts` — `describeReputationAction(txn)` maps known
  civic action types (`real_life_attested`, `peer_validated`,
  `validation_incorrect`, …) to icon + label + signed flag, falling back to the
  category bucket; `formatPointsDelta`.

## Donut vs bar

Shipped the **Skia donut** (`@shopify/react-native-skia`, already a commons dep;
precedent: `components/holographic-card.tsx`). It draws proportional stroked
arcs for the positive sources with a faint full track underneath (the sole ring
when nothing is earned) and a centred "earned" total. Penalties are excluded
from the ring by construction. The stacked-bar fallback was not needed.

## i18n

Extended `civic.reputation.*` in `en.json` + `es.json` (full parity): reused
`title`/`loading`/`total`/`bySource`/`bySourceSubtitle`/`offline`/`footnote`/
`sources`/`error` and `civic.trustTier.*`/`civic.validate.*`; added
`weightShort`, `standing`, `progress`, `stats`, `composition`, `duty`, and
`activity` (incl. `activity.actions.*`).

## Tests

Pure: `reputation-standing.test.ts`, `reputation-activity.test.ts`. Hook:
`useReputationActivity.test.tsx` (asserts the `(userId, 8)` call + disabled when
no id). Components: `StandingHero` / `CompositionCard` / `ActivityList`
(`__tests__/components/`) render under jsdom via extended RN/icon/Skia stubs and
assert tier + progress, sources + weight tags, and the activity list/empty/
loading/error states.
