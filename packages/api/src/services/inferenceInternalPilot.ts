/** Controlled payload budget, not a certified provider token or billing ceiling. */
import {
  type InternalMeteredPilot,
  type InternalMeteredPilotDeployment,
  pilotTextTerms,
} from '../config/inferenceEconomicPolicy';
import {
  type InferenceFundingPriority,
  PROMOTIONAL_CREDIT_FUNDING_PRIORITY,
} from './inferenceCatalogue.service';
import type { ConcretePowerLevel } from './inferencePowerLevels.service';
import type { EdgeOperation, NormalizedEdgeRequest } from '../schemas/inferenceEdge.schemas';

// Explicit local framing allowance; provider hidden prompts/framing remain outside
// this measurable budget. Serialize every controlled input field, including schemas.
const BASE_OVERHEAD = 256;
const MESSAGE_OVERHEAD = 32;
const TOOL_OVERHEAD = 32;

/**
 * The pilot terms that bind ONE operation. Speech answers to the pilot's own
 * speech block — exact characters, its own routes and quote ceiling, and no
 * generated-token ceiling — and is outside the pilot (`undefined`) without
 * one. Every other operation answers to the pilot's text terms, unchanged.
 */
export interface InternalPilotOperationTerms {
  /** Ceiling for {@link controlledInputBudget}'s figure for this operation. */
  readonly maxInput: number;
  /** Generated-token ceiling; `undefined` for an operation that generates none. */
  readonly maxOutputTokens: number | undefined;
  readonly maxPricePerRequestUsd: string | undefined;
  readonly deployments: readonly InternalMeteredPilotDeployment[];
  /** Image parts one request may carry; present only for a request carrying images. */
  readonly maxImages?: number;
}

/**
 * The terms that bind ONE request: its operation and, for a completion, how
 * many image parts it carries. A completion carrying images answers to the
 * pilot's `imageInput` terms (their routes and quote ceiling, the text terms'
 * input and output ceilings) and is outside a pilot without them.
 */
export function pilotTermsFor(
  pilot: InternalMeteredPilot,
  operation: EdgeOperation,
  images = 0,
): InternalPilotOperationTerms | undefined {
  if (operation.kind === 'speech') {
    const speech = pilot.speech;
    return speech === undefined
      ? undefined
      : {
          maxInput: speech.maxInputCharacters,
          maxOutputTokens: undefined,
          maxPricePerRequestUsd: speech.maxPricePerRequestUsd,
          deployments: speech.deployments,
        };
  }
  // Every other operation answers to the text terms; a pilot without them
  // (one that only embeds, for instance) leaves it outside the pilot.
  const text = pilotTextTerms(pilot);
  if (text === undefined) return undefined;
  if (images > 0) {
    const imageInput = pilot.imageInput;
    return imageInput === undefined
      ? undefined
      : {
          maxInput: text.maxControlledInputBudget,
          maxOutputTokens: text.maxOutputTokens,
          maxPricePerRequestUsd: imageInput.maxPricePerRequestUsd,
          deployments: imageInput.deployments,
          maxImages: imageInput.maxImages,
        };
  }
  return {
    maxInput: text.maxControlledInputBudget,
    maxOutputTokens: text.maxOutputTokens,
    maxPricePerRequestUsd: text.maxPricePerRequestUsd,
    deployments: text.deployments,
  };
}

export function controlledInputBudget(request: NormalizedEdgeRequest): number | undefined {
  // Speech is measured in what it is billed in: the exact characters of the one
  // text input (`input.length`, the figure the hold and quote use), never a
  // UTF-8 framing estimate. Any other shape is not a speech request this pilot knows.
  if (request.operation.kind === 'speech') {
    return request.input.format === 'text' &&
      request.input.text.length === request.operation.characters &&
      !request.stream &&
      request.audioOutput === undefined &&
      request.tools.length === 0
      ? request.operation.characters
      : undefined;
  }
  if (
    request.operation.kind !== 'completion' ||
    request.audioOutput !== undefined ||
    (request.input.format !== 'text' && request.input.format !== 'messages')
  )
    return undefined;
  if (
    request.input.format === 'messages' &&
    request.input.messages.some((message) =>
      message.content.some((part) => part.type !== 'text' && part.type !== 'image'),
    )
  )
    return undefined;
  const messages = request.input.format === 'messages' ? request.input.messages.length : 1;
  // An image's bytes are not text the model reads as tokens: each is bounded
  // apart, by its line's declared `imageInput` and the pilot's image count. The
  // part's framing (its type, media type and detail) still counts.
  const payload = JSON.stringify({
    input: withoutImageData(request.input),
    tools: request.tools,
    toolChoice: request.toolChoice,
    responseFormat: request.responseFormat,
  });
  return (
    Buffer.byteLength(payload, 'utf8') +
    BASE_OVERHEAD +
    MESSAGE_OVERHEAD * messages +
    TOOL_OVERHEAD * request.tools.length
  );
}

function withoutImageData(input: NormalizedEdgeRequest['input']): NormalizedEdgeRequest['input'] {
  if (input.format !== 'messages') return input;
  return {
    ...input,
    messages: input.messages.map((message) => ({
      ...message,
      content: message.content.map((part) =>
        part.type === 'image' && part.source.kind === 'inline'
          ? { ...part, source: { ...part.source, data: '' } }
          : part,
      ),
    })),
  };
}

/** Whether `route` is one of the exact tuples the pilot admits for this request. */
export function pilotAllowsDeployment(
  pilot: InternalMeteredPilot,
  operation: EdgeOperation,
  route: InternalMeteredPilotDeployment,
  images = 0,
): boolean {
  const deployments = pilotTermsFor(pilot, operation, images)?.deployments ?? [];
  return deployments.some(
    (allowed) =>
      allowed.deploymentId === route.deploymentId &&
      allowed.modelReference === route.modelReference &&
      allowed.provider === route.provider,
  );
}

/**
 * ADR 0037: the levels a pilot request NAMING `level` is resolved over —
 * `[level, fallbackLevel]` when the pilot's promotional-credit lane covers it
 * (the fallback only when the application's policy allows it), otherwise
 * `undefined` and the ordinary single level applies. Priority 0 is the lane's.
 */
export function promotionalLaneLevels(
  pilot: InternalMeteredPilot | undefined,
  level: ConcretePowerLevel,
  allowed: (level: ConcretePowerLevel) => boolean,
): ConcretePowerLevel[] | undefined {
  const lane = pilot?.promotionalCredit;
  if (lane === undefined || !lane.levels.includes(level)) return undefined;
  return lane.fallbackLevel !== level && allowed(lane.fallbackLevel)
    ? [level, lane.fallbackLevel]
    : [level];
}

/**
 * Whether a route's CURRENT economics are an available promotional credit
 * grant. `fundingPriority` exists only for evidence that resolved available
 * and inside its observation window at this request (`fundingPriorityFor`), so
 * a spent, stale or unknown grant is never promotional here, and a route the
 * sync fell back to `standard_payg` is not either. No name participates.
 */
export function fundedByPromotionalCredit(route: {
  readonly fundingPriority: InferenceFundingPriority;
}): boolean {
  return route.fundingPriority === PROMOTIONAL_CREDIT_FUNDING_PRIORITY;
}
