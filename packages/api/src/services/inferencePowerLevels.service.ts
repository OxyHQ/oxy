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
import type { ModelPowerClass, PowerLevel, ReasoningEffort } from '@oxy.so/contracts';
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
  readonly level: ConcretePowerLevel;
  /** Every rule that fired, for logs and support — never parsed. */
  readonly reasons: readonly string[];
}

/** A replaceable decision; the edge depends on this shape, not on the rules. */
export type AutoPowerLevelResolver = (features: AutoRoutingFeatures) => AutoPowerDecision;

/** Thresholds, named so the documentation and the tests quote one source. */
export const AUTO_THRESHOLDS = {
  mediumInputTokens: 8_000,
  highInputTokens: 64_000,
  mediumOutputTokens: 4_096,
  highOutputTokens: 16_000,
  highToolCount: 8,
} as const;

function atLeast(current: ConcretePowerLevel, floor: ConcretePowerLevel): ConcretePowerLevel {
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
export const classifyAutoPowerLevel: AutoPowerLevelResolver = (features) => {
  let level: ConcretePowerLevel = 'instant';
  const reasons: string[] = [];
  const raise = (floor: ConcretePowerLevel, reason: string): void => {
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
 * level, then each level above it up to {@link AUTO_CEILING} (or the decided
 * level itself when a rule put it higher). `allowed` narrows the ladder to the
 * levels an application's policy permits; an empty ladder is a refusal.
 */
export function autoLadder(
  decided: ConcretePowerLevel,
  allowed: (level: ConcretePowerLevel) => boolean
): ConcretePowerLevel[] {
  const start = CONCRETE_POWER_LEVELS.indexOf(decided);
  const end = Math.max(start, CONCRETE_POWER_LEVELS.indexOf(AUTO_CEILING));
  return CONCRETE_POWER_LEVELS.slice(start, end + 1).filter(allowed);
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

/** The effort each concrete level requests, read from its preset row. */
export async function powerLevelEfforts(): Promise<
  ReadonlyMap<ConcretePowerLevel, ReasoningEffort | undefined>
> {
  const rows = await getDb()
    .select({
      powerLevel: inferenceRoutingProfiles.powerLevel,
      reasoningEffort: inferenceRoutingProfiles.reasoningEffort,
    })
    .from(inferenceRoutingProfiles)
    .where(isNotNull(inferenceRoutingProfiles.powerLevel));
  const map = new Map<ConcretePowerLevel, ReasoningEffort | undefined>();
  for (const row of rows) {
    if (row.powerLevel === null || row.powerLevel === 'auto') continue;
    map.set(row.powerLevel, row.reasoningEffort ?? undefined);
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
  deploymentWhere: SQL | undefined
): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ modelId: inferenceModels.modelId })
    .from(inferenceModelPowerClasses)
    .innerJoin(inferenceModels, eq(inferenceModels.modelId, inferenceModelPowerClasses.modelId))
    .innerJoin(inferenceModelRevisions, eq(inferenceModelRevisions.modelId, inferenceModels.id))
    .innerJoin(
      inferenceDeployments,
      eq(inferenceDeployments.modelRevisionId, inferenceModelRevisions.id)
    )
    .where(
      and(
        eq(inferenceModelPowerClasses.powerClass, powerClass),
        eq(inferenceModelRevisions.isCurrent, true),
        deploymentWhere
      )
    );
  return rows
    .flatMap((row) => (row.modelId === null ? [] : [row.modelId]))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** The reviewed class of each of `modelIds` that has one. */
export async function powerClassesOf(
  modelIds: readonly string[]
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
