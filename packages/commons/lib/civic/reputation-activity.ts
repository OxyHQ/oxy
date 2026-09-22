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

import type { ReputationCategory, ReputationTransaction } from '@oxy.so/contracts';
import type { IconName } from '@/constants/icons';

/** Presentation metadata for one activity row. */
export interface ReputationActivityMeta {
  /** Leading icon for the row. */
  icon: IconName;
  /** i18n suffix — `civic.reputation.activity.actions.<labelKey>`. */
  labelKey: string;
  /** Whether the action carries an Oxy-signed attestation (verifiable). */
  signed: boolean;
  /** Whether the point delta is an award (`points >= 0`) vs a penalty. */
  positive: boolean;
}

/** Known civic / cross-app action types → icon + label + signed provenance. */
const ACTION_META: Readonly<
  Record<string, { icon: IconName; labelKey: string; signed: boolean }>
> = {
  real_life_attested: { icon: 'handshake', labelKey: 'realLife', signed: true },
  peer_validated: { icon: 'community', labelKey: 'peerValidated', signed: true },
  validation_correct: { icon: 'validation', labelKey: 'validationCorrect', signed: true },
  validation_incorrect: { icon: 'validation', labelKey: 'validationIncorrect', signed: true },
  personhood_vouched: { icon: 'endorsed', labelKey: 'vouched', signed: true },
  vouch_slashed: { icon: 'alert', labelKey: 'vouchSlashed', signed: true },
  endorsement_received: { icon: 'star', labelKey: 'endorsement', signed: false },
};

/** Category fallback when an `actionType` is not a known civic action. */
const CATEGORY_META: Readonly<
  Record<ReputationCategory, { icon: IconName; labelKey: string }>
> = {
  content: { icon: 'document', labelKey: 'content' },
  social: { icon: 'people', labelKey: 'social' },
  trust: { icon: 'shieldCheck', labelKey: 'trust' },
  moderation: { icon: 'report', labelKey: 'moderation' },
  physical: { icon: 'place', labelKey: 'physical' },
  penalty: { icon: 'alertStrong', labelKey: 'penalty' },
  other: { icon: 'bullet', labelKey: 'other' },
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
