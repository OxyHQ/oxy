/** Controlled payload budget, not a certified provider token or billing ceiling. */
import type { InternalMeteredPilot } from '../config/inferenceEconomicPolicy';
import {
  type InferenceFundingPriority,
  PROMOTIONAL_CREDIT_FUNDING_PRIORITY,
} from './inferenceCatalogue.service';
import type { ConcretePowerLevel } from './inferencePowerLevels.service';
import type { NormalizedEdgeRequest } from '../schemas/inferenceEdge.schemas';
import type { ScopedExecutionAudience } from '@oxy.so/contracts';
import { hashScopedInput } from './scopedExecution.service';

// Explicit local framing allowance; provider hidden prompts/framing remain outside
// this measurable budget. Serialize every controlled input field, including schemas.
const BASE_OVERHEAD = 256;
const MESSAGE_OVERHEAD = 32;
const TOOL_OVERHEAD = 32;

export function controlledInputBudget(
  request: NormalizedEdgeRequest,
  scopedPermit?: ScopedExecutionAudience,
): number | undefined {
  // Only an already authenticated, source-bound permit may extend this pilot.
  // Count the whole controlled input, including every question and choice.
  if (
    request.operation.kind === 'decisions' &&
    request.input.format === 'decisions' &&
    scopedPermit !== undefined &&
    Date.parse(scopedPermit.expiresAt) > Date.now() &&
    request.target?.kind === 'model' &&
    request.target.modelReference === scopedPermit.modelReference &&
    hashScopedInput(JSON.parse(JSON.stringify(request.input))) === scopedPermit.fixtureSha256 &&
    !request.stream &&
    request.audioOutput === undefined &&
    request.tools.length === 0
  ) {
    return (
      Buffer.byteLength(
        JSON.stringify({
          input: request.input,
          tools: request.tools,
          toolChoice: request.toolChoice,
          responseFormat: request.responseFormat,
        }),
        'utf8',
      ) + BASE_OVERHEAD
    );
  }
  if (
    request.operation.kind !== 'completion' ||
    request.audioOutput !== undefined ||
    (request.input.format !== 'text' && request.input.format !== 'messages')
  )
    return undefined;
  if (
    request.input.format === 'messages' &&
    request.input.messages.some((message) => message.content.some((part) => part.type !== 'text'))
  )
    return undefined;
  const messages = request.input.format === 'messages' ? request.input.messages.length : 1;
  const payload = JSON.stringify({
    input: request.input,
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

export function pilotAllowsDeployment(
  pilot: InternalMeteredPilot,
  route: {
    readonly deploymentId: string;
    readonly modelReference: string;
    readonly provider: string;
  },
  scopedPermit?: ScopedExecutionAudience,
): boolean {
  if (scopedPermit !== undefined)
    return (
      Date.parse(scopedPermit.expiresAt) > Date.now() &&
      scopedPermit.deploymentId === route.deploymentId &&
      scopedPermit.modelReference === route.modelReference &&
      scopedPermit.provider === route.provider
    );
  return pilot.deployments.some(
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
