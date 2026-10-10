/**
 * Power levels: the product-preset routing profiles an application names
 * INSTEAD of a model (`instant` … `ultra`, and `auto`), and the deterministic
 * `auto` heuristic.
 *
 * ## Two ways to call inference
 *
 * - **Exact** — the request names `publisher/model` (or `@revision`). Only that
 *   model runs; failover is same-model deployment failover only.
 * - **Power** — the request names a power level. Oxy chooses among the
 *   currently SERVABLE models whose reviewed class
 *   (`inference_model_power_classes`) matches the level, may choose a different
 *   model on every request, and may fail over ACROSS models inside the level.
 *   That cross-model failover is authorized by the profile itself (every signed
 *   route is a candidate of the level), reported in-stream as a `route_switch`
 *   event and recorded against the profile, and the response always names the
 *   concrete model that ran.
 *
 * Ranking inside a level is the edge's ordinary one: funding class (free
 * allowance → discounted pay-as-you-go → promotional credit → standard paid),
 * then the level's `optimiseFor` score (`price`), then exact deployment id.
 *
 * ## `auto`
 *
 * `auto` picks the CHEAPEST level that suffices for the request from features
 * the edge already has ({@link classifyAutoPowerLevel}); if that level has no
 * servable model it climbs the ladder, one priority per level, never past
 * {@link AUTO_CEILING}. `pro` and `ultra` are never chosen implicitly: they cost
 * an order of magnitude more and must be asked for by name.
 *
 * The heuristic sits behind {@link AutoPowerLevelResolver} so a trained
 * classifier can replace it without touching the edge.
 */

import { and, eq, inArray, isNotNull, type SQL } from 'drizzle-orm';
import {
  type ModelPowerClass,
  type PowerLevel,
  type ReasoningEffort,
  reasoningEffortSchema,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import {
  inferenceDeployments,
  inferenceModelPowerClasses,
  inferenceModelRevisions,
  inferenceModels,
  inferenceRoutingProfiles,
} from '../db/schema';

/** Levels a request can land on, cheapest first. `auto` is not one of them. */
export const CONCRETE_POWER_LEVELS = [
  'instant',
  'medium',
  'high',
  'xhigh',
  'pro',
  'ultra',
] as const satisfies readonly Exclude<PowerLevel, 'auto'>[];

export type ConcretePowerLevel = (typeof CONCRETE_POWER_LEVELS)[number];

/** Strict vocabulary for automatic selection, including untrusted classifier output. */
export const AUTO_POWER_LEVELS = Object.freeze(['instant', 'medium', 'high', 'xhigh'] as const);
export type AutoPowerLevel = (typeof AUTO_POWER_LEVELS)[number];

export function isAutoPowerLevel(value: unknown): value is AutoPowerLevel {
  return typeof value === 'string' && AUTO_POWER_LEVELS.some((level) => level === value);
}

/** Which reviewed model class each level chooses from. */
export const POWER_LEVEL_CLASS: Readonly<Record<ConcretePowerLevel, ModelPowerClass>> = {
  instant: 'instant',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  pro: 'pro',
  ultra: 'ultra',
};

/** The highest level `auto` may climb to. */
export const AUTO_CEILING: ConcretePowerLevel = 'xhigh';

/* -------------------------------------------------------------------------- */
/*  A level's reasoning effort                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a level ASKS for, least reasoning first. Wider than the contract's
 * {@link ReasoningEffort} (`low` / `medium` / `high`): `instant` asks for NO
 * reasoning, and `none` and `minimal` name that intent even though no request
 * can carry them today — a target is resolved against a deployment's accepted
 * efforts before anything is sent ({@link resolvePowerLevelEffort}).
 */
export const POWER_EFFORT_TARGETS = ['none', 'minimal', 'low', 'medium', 'high'] as const;

export type PowerEffortTarget = (typeof POWER_EFFORT_TARGETS)[number];

/**
 * The effort a level sends to one deployment: the LOWEST effort it accepts at
 * or above the level's target, else (nothing accepted that high) the highest it
 * accepts; `undefined` when it accepts none (a model without effort control,
 * or a deployment whose upstream refuses the parameter).
 *
 * The direction matters most at the bottom: a reasoning model sent no effort
 * reasons at its provider's DEFAULT (often `medium`), so `instant` (target
 * `none`) sending nothing to `gpt-oss` spent a 30-token budget entirely on
 * reasoning. Clamped, `instant` gets `low` there — the least the vocabulary can
 * ask for — and `medium` (target `low`) gets `low` or the next effort up.
 */
export function resolvePowerLevelEffort(
  target: PowerEffortTarget,
  accepted: readonly string[],
): ReasoningEffort | undefined {
  const rank = (effort: string): number =>
    POWER_EFFORT_TARGETS.indexOf(effort as PowerEffortTarget);
  const expressible = accepted
    .filter((effort): effort is ReasoningEffort => reasoningEffortSchema.safeParse(effort).success)
    .sort((left, right) => rank(left) - rank(right));
  const floor = rank(target);
  return expressible.find((effort) => rank(effort) >= floor) ?? expressible.at(-1);
}

/* -------------------------------------------------------------------------- */
/*  The auto heuristic                                                        */
/* -------------------------------------------------------------------------- */

/** The request features `auto` decides on — all known at admission. */
export interface AutoRoutingFeatures {
  readonly toolCount: number;
  readonly estimatedInputTokens: number;
  /** Absent when the caller did not bound output. */
  readonly maxOutputTokens?: number;
  /** Input part types other than `text` (image, audio, file …). */
  readonly nonTextInput: boolean;
  /** What the caller explicitly asked for, if anything. */
  readonly requestedEffort?: ReasoningEffort;
  /** `json_schema` (strict structure) or `json_object`. */
  readonly structuredOutput: boolean;
}

export interface AutoPowerDecision {
  readonly level: AutoPowerLevel;
  /** Every rule that fired, for logs and support — never parsed. */
  readonly reasons: readonly string[];
  /** Semantic recommendation and fallback status are separate from feature floors. */
  readonly classification?:
    | { readonly source: 'deterministic'; readonly reason: string; readonly version: string }
    | {
        readonly source: 'jev';
        readonly version: string;
        readonly modelReference: string;
        readonly recommendedLevel: AutoPowerLevel;
        /** The provider's own confidence in its reply; metadata, never a routing input. */
        readonly providerConfidence: number;
      };
}

/** A replaceable decision; the edge depends on this shape, not on the rules. */
export interface AutoPowerLevelContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  /** Transient input, evaluated only after the semantic classifier's gates pass. */
  readonly state: () => string;
}

export type AutoPowerLevelResolver = (
  features: AutoRoutingFeatures,
  context?: AutoPowerLevelContext,
) => AutoPowerDecision | Promise<AutoPowerDecision>;

/** Thresholds, named so the documentation and the tests quote one source. */
export const AUTO_THRESHOLDS = {
  mediumInputTokens: 8_000,
  highInputTokens: 64_000,
  mediumOutputTokens: 4_096,
  highOutputTokens: 16_000,
  highToolCount: 8,
} as const;

function atLeast(current: AutoPowerLevel, floor: AutoPowerLevel): AutoPowerLevel {
  return CONCRETE_POWER_LEVELS.indexOf(floor) > CONCRETE_POWER_LEVELS.indexOf(current)
    ? floor
    : current;
}

/**
 * The deterministic v1 rule: start at `instant` and raise the floor for each
 * feature that needs more. The result is the MAXIMUM floor any rule set.
 *
 * | feature                                         | floor   |
 * |-------------------------------------------------|---------|
 * | explicit `reasoning.effort: low`                | medium  |
 * | explicit `reasoning.effort: medium`             | high    |
 * | explicit `reasoning.effort: high`               | xhigh   |
 * | ≥ 1 tool                                        | medium  |
 * | > 8 tools                                       | high    |
 * | structured output (`json_schema`/`json_object`) | medium  |
 * | any non-text input part                         | medium  |
 * | estimated input > 8 000 tokens                  | medium  |
 * | estimated input > 64 000 tokens                 | high    |
 * | `maxOutputTokens` > 4 096                       | medium  |
 * | `maxOutputTokens` > 16 000                      | high    |
 */
export const classifyAutoPowerLevel = (features: AutoRoutingFeatures): AutoPowerDecision => {
  let level: AutoPowerLevel = 'instant';
  const reasons: string[] = [];
  const raise = (floor: AutoPowerLevel, reason: string): void => {
    level = atLeast(level, floor);
    reasons.push(`${reason}->${floor}`);
  };

  if (features.requestedEffort === 'low') raise('medium', 'reasoning_effort_low');
  if (features.requestedEffort === 'medium') raise('high', 'reasoning_effort_medium');
  if (features.requestedEffort === 'high') raise('xhigh', 'reasoning_effort_high');
  if (features.toolCount > AUTO_THRESHOLDS.highToolCount) raise('high', 'many_tools');
  else if (features.toolCount > 0) raise('medium', 'tools');
  if (features.structuredOutput) raise('medium', 'structured_output');
  if (features.nonTextInput) raise('medium', 'non_text_input');
  if (features.estimatedInputTokens > AUTO_THRESHOLDS.highInputTokens) raise('high', 'large_input');
  else if (features.estimatedInputTokens > AUTO_THRESHOLDS.mediumInputTokens) {
    raise('medium', 'medium_input');
  }
  if (features.maxOutputTokens !== undefined) {
    if (features.maxOutputTokens > AUTO_THRESHOLDS.highOutputTokens) raise('high', 'large_output');
    else if (features.maxOutputTokens > AUTO_THRESHOLDS.mediumOutputTokens) {
      raise('medium', 'medium_output');
    }
  }
  return { level, reasons };
};

/**
 * The levels `auto` may use for this request, in priority order: the decided
 * level, then each level above it up to {@link AUTO_CEILING}. Invalid classifier
 * values cannot enter the ladder. `allowed` narrows the ladder to the
 * levels an application's policy permits; an empty ladder is a refusal.
 */
export function autoLadder(
  decided: unknown,
  allowed: (level: ConcretePowerLevel) => boolean,
): ConcretePowerLevel[] {
  if (!isAutoPowerLevel(decided)) return [];
  return AUTO_POWER_LEVELS.slice(AUTO_POWER_LEVELS.indexOf(decided)).filter(allowed);
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

/** `power_level → profile id` for the seven presets (fixed ids, seeded by migration). */
export async function powerLevelProfileIds(): Promise<ReadonlyMap<PowerLevel, string>> {
  const rows = await getDb()
    .select({ id: inferenceRoutingProfiles.id, powerLevel: inferenceRoutingProfiles.powerLevel })
    .from(inferenceRoutingProfiles)
    .where(isNotNull(inferenceRoutingProfiles.powerLevel));
  const map = new Map<PowerLevel, string>();
  for (const row of rows) if (row.powerLevel !== null) map.set(row.powerLevel, row.id);
  return map;
}

/**
 * The effort each concrete level TARGETS, read from its preset row. A row with
 * no effort (`instant`) asks for no reasoning: its target is `none`, which
 * {@link resolvePowerLevelEffort} clamps to the least a deployment accepts.
 */
export async function powerLevelEfforts(): Promise<
  ReadonlyMap<ConcretePowerLevel, PowerEffortTarget>
> {
  const rows = await getDb()
    .select({
      powerLevel: inferenceRoutingProfiles.powerLevel,
      reasoningEffort: inferenceRoutingProfiles.reasoningEffort,
    })
    .from(inferenceRoutingProfiles)
    .where(isNotNull(inferenceRoutingProfiles.powerLevel));
  const map = new Map<ConcretePowerLevel, PowerEffortTarget>();
  for (const row of rows) {
    if (row.powerLevel === null || row.powerLevel === 'auto') continue;
    map.set(row.powerLevel, row.reasoningEffort ?? 'none');
  }
  return map;
}

/**
 * Canonical ids of the models in `powerClass` that have at least one approved,
 * offerable deployment of a current revision. Servability beyond that — live
 * Kaana publication, price, score and funding evidence — is decided by the
 * catalogue and the edge, which drop a model none of whose routes qualifies.
 * Sorted, so the candidate list is deterministic; ranking is the edge's.
 */
export async function powerClassModelIds(
  powerClass: ModelPowerClass,
  deploymentWhere: SQL | undefined,
): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ modelId: inferenceModels.modelId })
    .from(inferenceModelPowerClasses)
    .innerJoin(inferenceModels, eq(inferenceModels.modelId, inferenceModelPowerClasses.modelId))
    .innerJoin(inferenceModelRevisions, eq(inferenceModelRevisions.modelId, inferenceModels.id))
    .innerJoin(
      inferenceDeployments,
      eq(inferenceDeployments.modelRevisionId, inferenceModelRevisions.id),
    )
    .where(
      and(
        eq(inferenceModelPowerClasses.powerClass, powerClass),
        eq(inferenceModelRevisions.isCurrent, true),
        deploymentWhere,
      ),
    );
  return rows
    .flatMap((row) => (row.modelId === null ? [] : [row.modelId]))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** The reviewed class of each of `modelIds` that has one. */
export async function powerClassesOf(
  modelIds: readonly string[],
): Promise<ReadonlyMap<string, ModelPowerClass>> {
  if (modelIds.length === 0) return new Map();
  const rows = await getDb()
    .select({
      modelId: inferenceModelPowerClasses.modelId,
      powerClass: inferenceModelPowerClasses.powerClass,
    })
    .from(inferenceModelPowerClasses)
    .where(inArray(inferenceModelPowerClasses.modelId, [...modelIds]));
  return new Map(rows.map((row) => [row.modelId, row.powerClass] as const));
}
