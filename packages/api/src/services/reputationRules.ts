/**
 * The Oxy Trust reputation rules — in code, versioned, public.
 *
 * Every ordinary award takes its points, category and cooldown from here and
 * nowhere else. There is no table and no endpoint that edits a rule: nobody at
 * Oxy can re-price an action, and so nobody can move a person's standing by
 * hand. Changing a rule is a reviewed change to this file, and bumps
 * {@link REPUTATION_RULES_VERSION}.
 *
 * Moderation consequences are NOT here: they come from the versioned conduct
 * policy through the moderation bridge (`ruleOverride`), and a conduct action
 * type can never be a rule (see `CONDUCT_ACTION_TYPES`).
 */
import type { ReputationCategory } from '@oxy.so/contracts';
import {
  CLEAN_MOVEOUT_ACTION,
  CLEAN_MOVEOUT_POINTS,
  ENDORSEMENT_RECEIVED_ACTION,
  ENDORSEMENT_RECEIVED_POINTS,
  LEASE_COMPLETED_ACTION,
  LEASE_COMPLETED_POINTS,
  LEASE_DEFAULT_ACTION,
  LEASE_DEFAULT_POINTS,
  LEASE_SIGNED_ACTION,
  LEASE_SIGNED_POINTS,
  PEER_VALIDATED_ACTION,
  PEER_VALIDATED_POINTS,
  PERSONHOOD_VOUCHED_ACTION,
  PERSONHOOD_VOUCHED_POINTS,
  REAL_LIFE_ATTESTED_ACTION,
  REAL_LIFE_ATTESTED_POINTS,
  VALIDATION_CORRECT_ACTION,
  VALIDATION_CORRECT_POINTS,
  VALIDATION_INCORRECT_ACTION,
  VALIDATION_INCORRECT_POINTS,
  VOUCH_SLASHED_ACTION,
  VOUCH_SLASHED_POINTS,
} from '../utils/reputation.constants';

/** Bump on every change to {@link REPUTATION_RULES}. */
export const REPUTATION_RULES_VERSION = 1;

export interface ReputationRuleDefinition {
  /** Unique action key, e.g. `endorsement_received`. */
  readonly actionType: string;
  /** Signed points. Negative for a penalty. */
  readonly points: number;
  readonly category: ReputationCategory;
  readonly description: string;
  /** Per (user, action) cooldown; `0` disables it. */
  readonly cooldownInMinutes: number;
}

export const REPUTATION_RULES: readonly ReputationRuleDefinition[] = Object.freeze([
  {
    actionType: ENDORSEMENT_RECEIVED_ACTION,
    points: ENDORSEMENT_RECEIVED_POINTS,
    category: 'social',
    description: 'Endorsed by another user in a connected app',
    cooldownInMinutes: 0,
  },
  // Civic / Commons — crypto-owned reputation.
  {
    actionType: REAL_LIFE_ATTESTED_ACTION,
    points: REAL_LIFE_ATTESTED_POINTS,
    category: 'physical',
    description: 'A real-world interaction a counterparty cryptographically attested',
    cooldownInMinutes: 0,
  },
  {
    actionType: PEER_VALIDATED_ACTION,
    points: PEER_VALIDATED_POINTS,
    category: 'trust',
    description: 'Validated by a randomly-selected jury of peers',
    cooldownInMinutes: 0,
  },
  {
    actionType: VALIDATION_CORRECT_ACTION,
    points: VALIDATION_CORRECT_POINTS,
    category: 'trust',
    description: 'Voted with the resolving majority on a peer validation',
    cooldownInMinutes: 0,
  },
  {
    actionType: VALIDATION_INCORRECT_ACTION,
    points: VALIDATION_INCORRECT_POINTS,
    category: 'penalty',
    description: 'Endorsed a verdict later reverted as fraud',
    cooldownInMinutes: 0,
  },
  {
    actionType: PERSONHOOD_VOUCHED_ACTION,
    points: PERSONHOOD_VOUCHED_POINTS,
    category: 'trust',
    description: 'Vouched for as a real person by a staking voucher',
    cooldownInMinutes: 0,
  },
  {
    actionType: VOUCH_SLASHED_ACTION,
    points: VOUCH_SLASHED_POINTS,
    category: 'penalty',
    description: 'Vouched for a person found to be fake (staking slash)',
    cooldownInMinutes: 0,
  },
  // Homiio lease lifecycle — awarded by the Homiio service credential.
  {
    actionType: LEASE_SIGNED_ACTION,
    points: LEASE_SIGNED_POINTS,
    category: 'trust',
    description: 'Lease fully signed by landlord and tenant (Homiio)',
    cooldownInMinutes: 0,
  },
  {
    actionType: LEASE_COMPLETED_ACTION,
    points: LEASE_COMPLETED_POINTS,
    category: 'trust',
    description: 'Lease completed without early termination (Homiio)',
    cooldownInMinutes: 0,
  },
  {
    actionType: CLEAN_MOVEOUT_ACTION,
    points: CLEAN_MOVEOUT_POINTS,
    category: 'trust',
    description: 'Clean move-out with no damage or outstanding obligations (Homiio)',
    cooldownInMinutes: 0,
  },
  {
    actionType: LEASE_DEFAULT_ACTION,
    points: LEASE_DEFAULT_POINTS,
    category: 'penalty',
    description: 'Lease ended in default — unpaid rent, abandonment, or breach (Homiio)',
    cooldownInMinutes: 0,
  },
]);

const BY_ACTION_TYPE: ReadonlyMap<string, ReputationRuleDefinition> = new Map(
  REPUTATION_RULES.map((rule) => [rule.actionType, rule])
);

/** The rule for `actionType`, or `undefined` when no rule prices it. */
export function findReputationRule(actionType: string): ReputationRuleDefinition | undefined {
  return BY_ACTION_TYPE.get(actionType);
}
