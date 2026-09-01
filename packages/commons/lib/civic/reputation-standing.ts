/**
 * Pure "standing" derivations for the reputation hero.
 *
 * Translates a `ReputationBalance` into the two things the hero renders that are
 * not already on the wire:
 *
 *   1. `getTierProgress(tier, total)` — where the user sits on the points ladder
 *      and how far the NEXT tier is. The point thresholds mirror the server's
 *      single source of truth, `packages/api/src/utils/reputation.constants.ts`
 *      (`TRUST_TIER_TRUSTED_MIN` / `TRUST_TIER_HIGH_TRUST_MIN`). Commons cannot
 *      import `@oxyhq/api`, so the values are mirrored here with a reference
 *      comment — the same pattern `card-presentation.ts` (mirrors the wire enums)
 *      and `reputation-sources.ts` (mirrors the breakdown) already use.
 *   2. The human-facing influence multiplier and reliability percent, formatted
 *      from the already-capped `influence` / `reliability` blocks.
 *
 * `verified` is NOT a points tier — it is granted by proof-of-personhood
 * (`User.verified`) and represents the maximum standing, so it is reported as a
 * dedicated `max` state with no progress bar. `restricted` is punitive
 * (`total < 0` or a high abuse score) and likewise has no forward progress.
 */

import type { TrustTier, ReputationInfluence, ReputationReliability } from '@oxyhq/contracts';

/** Minimum lifetime total for the `trusted` tier (mirror reputation.constants.ts). */
export const TRUST_TIER_TRUSTED_MIN = 100;

/** Minimum lifetime total for the `high_trust` tier (mirror reputation.constants.ts). */
export const TRUST_TIER_HIGH_TRUST_MIN = 500;

/**
 * The points ladder, lowest → highest. Only the points-earned tiers appear;
 * `verified` (personhood) and `restricted` (punitive) are handled separately.
 */
const POINTS_TIER_LADDER: readonly { tier: TrustTier; min: number }[] = [
  { tier: 'new', min: 0 },
  { tier: 'trusted', min: TRUST_TIER_TRUSTED_MIN },
  { tier: 'high_trust', min: TRUST_TIER_HIGH_TRUST_MIN },
];

/**
 * The hero's standing state.
 *  - `progress`   — climbing toward `nextTier`; render the progress bar + copy.
 *  - `topPoints`  — at `high_trust`, the highest points tier; the only step up is
 *                   personhood (`verified`), so there is no points bar.
 *  - `max`        — `verified` human; maximum standing, no progress bar.
 *  - `restricted` — punitive; no forward progress.
 */
export type TierProgress =
  | {
      kind: 'progress';
      /** The user's current lifetime total. */
      current: number;
      /** Lifetime total required to reach `nextTier`. */
      targetMin: number;
      /** Points still needed to reach `nextTier` (never negative). */
      remaining: number;
      /** The tier unlocked at `targetMin`. */
      nextTier: TrustTier;
      /** Fill fraction within the CURRENT tier band, clamped to [0, 1]. */
      fraction: number;
    }
  | { kind: 'topPoints'; current: number }
  | { kind: 'max' }
  | { kind: 'restricted' };

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Derive the hero standing state from a trust tier and lifetime total.
 *
 * @param tier - The balance's `trustTier`.
 * @param total - The balance's lifetime `total`.
 */
export function getTierProgress(tier: TrustTier, total: number): TierProgress {
  if (tier === 'verified') return { kind: 'max' };
  if (tier === 'restricted') return { kind: 'restricted' };

  const index = POINTS_TIER_LADDER.findIndex((entry) => entry.tier === tier);
  const current = index < 0 ? 0 : index;
  const next = POINTS_TIER_LADDER[current + 1];
  if (!next) return { kind: 'topPoints', current: total };

  const floor = POINTS_TIER_LADDER[current].min;
  const band = next.min - floor;
  const fraction = band <= 0 ? 1 : clamp((total - floor) / band, 0, 1);

  return {
    kind: 'progress',
    current: total,
    targetMin: next.min,
    remaining: Math.max(0, next.min - total),
    nextTier: next.tier,
    fraction,
  };
}

/**
 * Format the capped default influence weight as a multiplier chip value, e.g.
 * `1.4 → "×1.4"`. The weight is already clamped to [0.1, 3.0] server-side.
 */
export function formatInfluenceMultiplier(influence: ReputationInfluence): string {
  return `×${influence.defaultWeight.toFixed(1)}`;
}

/**
 * Format report reliability as a whole-percent chip value, e.g. `0.9 → "90%"`.
 * A user with no report history scores a neutral 0.5 (`"50%"`).
 */
export function formatReliabilityPercent(reliability: ReputationReliability): string {
  return `${Math.round(clamp(reliability.reportAccuracyScore, 0, 1) * 100)}%`;
}
