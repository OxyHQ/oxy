/**
 * Map a reputation ledger transaction to its activity-row presentation.
 *
 * The reputation ledger records WHY each point delta happened via a stable
 * `actionType` (e.g. `real_life_attested`, `peer_validated`,
 * `validation_incorrect`) plus a `category` bucket. The recent-activity list
 * turns each transaction into a small human row: an icon, a label key under
 * `civic.reputation.activity.actions.*`, whether the action is Oxy-signed
 * (crypto-attested, so it carries a verifiable provenance indicator), and the
 * sign of its point delta.
 *
 * Known civic action types are matched first (these carry an Oxy-signed
 * attestation record, see `services/civic/attestation.service.ts`); anything
 * else falls back to its category bucket. This is a pure mapping — no React, no
 * colours — so it is unit-tested without rendering. Action keys mirror
 * `packages/api/src/utils/reputation.constants.ts`.
 */

import type { ReputationCategory, ReputationTransaction } from '@oxyhq/contracts';
import type { MaterialCommunityIconName } from '@/types/icons';

/** Presentation metadata for one activity row. */
export interface ReputationActivityMeta {
  /** Leading icon for the row. */
  icon: MaterialCommunityIconName;
  /** i18n suffix — `civic.reputation.activity.actions.<labelKey>`. */
  labelKey: string;
  /** Whether the action carries an Oxy-signed attestation (verifiable). */
  signed: boolean;
  /** Whether the point delta is an award (`points >= 0`) vs a penalty. */
  positive: boolean;
}

/** Known civic / cross-app action types → icon + label + signed provenance. */
const ACTION_META: Readonly<
  Record<string, { icon: MaterialCommunityIconName; labelKey: string; signed: boolean }>
> = {
  real_life_attested: { icon: 'handshake-outline', labelKey: 'realLife', signed: true },
  peer_validated: { icon: 'account-group-outline', labelKey: 'peerValidated', signed: true },
  validation_correct: { icon: 'gavel', labelKey: 'validationCorrect', signed: true },
  validation_incorrect: { icon: 'gavel', labelKey: 'validationIncorrect', signed: true },
  personhood_vouched: { icon: 'account-heart-outline', labelKey: 'vouched', signed: true },
  vouch_slashed: { icon: 'account-alert-outline', labelKey: 'vouchSlashed', signed: true },
  endorsement_received: { icon: 'star-outline', labelKey: 'endorsement', signed: false },
};

/** Category fallback when an `actionType` is not a known civic action. */
const CATEGORY_META: Readonly<
  Record<ReputationCategory, { icon: MaterialCommunityIconName; labelKey: string }>
> = {
  content: { icon: 'file-document-outline', labelKey: 'content' },
  social: { icon: 'account-multiple-outline', labelKey: 'social' },
  trust: { icon: 'shield-check-outline', labelKey: 'trust' },
  moderation: { icon: 'flag-outline', labelKey: 'moderation' },
  physical: { icon: 'map-marker-check-outline', labelKey: 'physical' },
  penalty: { icon: 'alert-octagon-outline', labelKey: 'penalty' },
  other: { icon: 'circle-small', labelKey: 'other' },
};

/**
 * Resolve the activity-row presentation for a transaction.
 *
 * @param txn - The ledger transaction (only `actionType`, `category`, `points`
 *   are read).
 */
export function describeReputationAction(
  txn: Pick<ReputationTransaction, 'actionType' | 'category' | 'points'>,
): ReputationActivityMeta {
  const positive = txn.points >= 0;

  const byAction = ACTION_META[txn.actionType];
  if (byAction) {
    return { icon: byAction.icon, labelKey: byAction.labelKey, signed: byAction.signed, positive };
  }

  const byCategory = CATEGORY_META[txn.category] ?? CATEGORY_META.other;
  return { icon: byCategory.icon, labelKey: byCategory.labelKey, signed: false, positive };
}

/** Format a signed point delta for display, e.g. `8 → "+8"`, `-10 → "-10"`. */
export function formatPointsDelta(points: number): string {
  return points >= 0 ? `+${points}` : `${points}`;
}
