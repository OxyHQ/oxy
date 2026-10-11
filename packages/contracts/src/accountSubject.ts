/**
 * Account subject contract — what an account IS, kept apart from how it proves
 * itself, who may become it, who may act as it, who acted, and whose money moves.
 *
 * `AccountKind` (`accountGraph.ts`) names the nature of an account. Five other
 * questions are routinely asked of an account, and each has its own answer here
 * or in `accountGraph.ts`. None of them may be answered by testing `kind`
 * directly at a call site:
 *
 * | question                                  | answered by                              |
 * |-------------------------------------------|------------------------------------------|
 * | may a PERSON switch into it?              | `isOperatorSwitchTargetKind`             |
 * | may someone act AS it on their authority? | `isDelegatedActAsEligibleKind`           |
 * | who is the ACTOR when it acts unoperated? | {@link accountKindActorNature}           |
 * | who acted, and as whom, on this request?  | {@link AccountActorChain}                |
 * | whose money / receipt is an effect?       | {@link attributeFinancialEffect}         |
 * | roles, resources, plan, balance, payer    | NOT kind — {@link KIND_INDEPENDENT_ACCOUNT_DIMENSIONS} |
 *
 * ## A bot is a complete account (issue #1520, I01)
 *
 * A `bot` is an AI agent's own identity. It owns resources, holds roles, has a
 * plan, holds a balance, receives funds and pays for itself under exactly the
 * rules a personal account does. Nothing commercial derives from it being a bot,
 * and nothing about it requires its owner's approval merely because it is one.
 *
 * Two things DO differ, and both are about seats, not capability:
 *
 *  - a person never switches INTO a bot (`isOperatorSwitchTargetKind`): a bot is
 *    somebody, not a seat a human occupies;
 *  - when a bot acts with nobody operating it, the actor recorded is the BOT
 *    ({@link accountKindActorNature} `'agent'`), never its owner.
 */

import { z } from 'zod';
import type { AccountKind } from './accountGraph';
import { oxyAccountIdSchema } from './inference/identifiers';

/** Bumped when any shape in this module changes incompatibly. */
export const ACCOUNT_SUBJECT_CONTRACT_VERSION = 1 as const;

// ===========================================================================
// Actor nature
// ===========================================================================

/**
 * Who is recorded as the ACTOR when an account of this kind acts and no other
 * account is operating it.
 *
 *  - `person` — a human; a personal account is its own actor.
 *  - `agent`  — an AI agent; a bot is its own actor (ADR 0018 `ActorRef`
 *    `{type:'agent'}`), and audit records the bot, never the human who owns it.
 *  - `operated` — never its own actor. An organization, project or channel only
 *    acts through a member, and that member is the actor.
 */
export const ACCOUNT_ACTOR_NATURES = ['person', 'agent', 'operated'] as const;

export type AccountActorNature = (typeof ACCOUNT_ACTOR_NATURES)[number];

export const accountActorNatureSchema = z.enum(ACCOUNT_ACTOR_NATURES);

/**
 * The actor nature of a kind. A `Record` over the full union, so a new kind does
 * not compile until somebody decides this for it.
 */
const ACTOR_NATURE_BY_KIND: Readonly<Record<AccountKind, AccountActorNature>> = {
  personal: 'person',
  bot: 'agent',
  organization: 'operated',
  project: 'operated',
  channel: 'operated',
};

/** `null` for a value that is not an account kind. Never a guess. */
export function accountKindActorNature(
  kind: AccountKind | null | undefined,
): AccountActorNature | null {
  if (!kind || !Object.prototype.hasOwnProperty.call(ACTOR_NATURE_BY_KIND, kind)) {
    return null;
  }
  return ACTOR_NATURE_BY_KIND[kind];
}

/** Whether an account of this kind can be the actor of its own actions. */
export function accountKindActsAsItself(kind: AccountKind | null | undefined): boolean {
  const nature = accountKindActorNature(kind);
  return nature === 'person' || nature === 'agent';
}

// ===========================================================================
// Kind-independent dimensions
// ===========================================================================

/**
 * What an account's KIND never decides.
 *
 * There is deliberately no predicate taking a kind for any of these. A member's
 * role grants the same permissions whatever kind the member is; a plan, a
 * balance, the payer and the beneficiary are resolved from billing state and
 * membership, never from `kind`. A bot and a person with the same role and plan
 * get the same action and the same commercial treatment.
 *
 * Listed so a consumer can cite the rule, and so the API's static guard
 * (`commercialTreatmentIgnoresAccountKind.test.ts`) has a single source.
 */
export const KIND_INDEPENDENT_ACCOUNT_DIMENSIONS = [
  'roles',
  'resources',
  'plan',
  'balance',
  'payer',
  'beneficiary',
] as const;

export type KindIndependentAccountDimension = (typeof KIND_INDEPENDENT_ACCOUNT_DIMENSIONS)[number];

// ===========================================================================
// Actor chain
// ===========================================================================

/**
 * Who acted, and as whom, for one authenticated request.
 *
 *  - `effectiveAccountId` — the account the request speaks AS (token `sub`).
 *  - `actorAccountId` — who actually acted (token `act.sub`): the human operating
 *    a managed account, or the account itself when nobody operates it.
 *  - `delegated` — exactly `actorAccountId !== effectiveAccountId`. Carried as
 *    its own field so a consumer reads a fact instead of re-deriving it, and
 *    refined so the two can never disagree.
 *
 * Produced ONLY by the session authority (Oxy's `/session/validate*`) from the
 * session ROW. A header or an unverified token claim never produces one: that is
 * what keeps a modified header from changing the actor.
 */
export const accountActorChainSchema = z
  .object({
    schemaVersion: z.literal(ACCOUNT_SUBJECT_CONTRACT_VERSION),
    effectiveAccountId: oxyAccountIdSchema,
    actorAccountId: oxyAccountIdSchema,
    delegated: z.boolean(),
  })
  .strict()
  .refine((chain) => chain.delegated === (chain.actorAccountId !== chain.effectiveAccountId), {
    message: 'delegated must be true exactly when the actor differs from the effective account',
    path: ['delegated'],
  });

export type AccountActorChain = z.infer<typeof accountActorChainSchema>;

/**
 * Build the chain from a session's binding: its subject and the operator
 * recorded on it (`sessions.operated_by_user_id`), if any.
 *
 * The one constructor, so producers cannot each invent a rule. An operator equal
 * to the subject is not a delegation.
 */
export function accountActorChainFromSession(binding: {
  readonly subjectAccountId: string;
  readonly operatedByAccountId?: string | null;
}): AccountActorChain {
  const actor = binding.operatedByAccountId || binding.subjectAccountId;
  return accountActorChainSchema.parse({
    schemaVersion: ACCOUNT_SUBJECT_CONTRACT_VERSION,
    effectiveAccountId: binding.subjectAccountId,
    actorAccountId: actor,
    delegated: actor !== binding.subjectAccountId,
  });
}

// ===========================================================================
// Financial subject
// ===========================================================================

/** `debit` — the subject pays; `credit` — the subject receives. */
export const FINANCIAL_EFFECT_DIRECTIONS = ['debit', 'credit'] as const;

export type FinancialEffectDirection = (typeof FINANCIAL_EFFECT_DIRECTIONS)[number];

/**
 * Whose money a financial effect is, and who caused it.
 *
 * `subjectAccountId` is the account the effect BELONGS to — the payer of a
 * debit, the beneficiary of a credit — and it is always the EFFECTIVE account of
 * the actor chain. Never the operator: a person paying from the bot they operate
 * spends the bot's money, and the receipt names the bot as payer and the person
 * as actor. Never the owner: a bot paying for itself is recorded as the bot.
 *
 * What this does NOT decide is which balance row FUNDS a debit. That is the
 * billing walk's answer (ADR 0014: the account's own active profile, else its
 * nearest ancestor's) and it is kind-independent; this contract only fixes the
 * subject and the actor the receipt must carry. Moving money is not done here.
 */
export const financialEffectAttributionSchema = z
  .object({
    schemaVersion: z.literal(ACCOUNT_SUBJECT_CONTRACT_VERSION),
    direction: z.enum(FINANCIAL_EFFECT_DIRECTIONS),
    subjectAccountId: oxyAccountIdSchema,
    actor: accountActorChainSchema,
  })
  .strict()
  .refine((effect) => effect.subjectAccountId === effect.actor.effectiveAccountId, {
    message: 'a financial effect belongs to the effective account, never the operator',
    path: ['subjectAccountId'],
  });

export type FinancialEffectAttribution = z.infer<typeof financialEffectAttributionSchema>;

/** Attribute a payment or a receipt to the subject the actor chain speaks as. */
export function attributeFinancialEffect(
  direction: FinancialEffectDirection,
  actor: AccountActorChain,
): FinancialEffectAttribution {
  return financialEffectAttributionSchema.parse({
    schemaVersion: ACCOUNT_SUBJECT_CONTRACT_VERSION,
    direction,
    subjectAccountId: actor.effectiveAccountId,
    actor,
  });
}
