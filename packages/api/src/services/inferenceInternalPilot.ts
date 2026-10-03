/** Controlled payload budget, not a certified provider token or billing ceiling. */
import type { InternalMeteredPilot } from '../config/inferenceEconomicPolicy';
import type { NormalizedEdgeRequest } from '../schemas/inferenceEdge.schemas';

// Explicit local framing allowance; provider hidden prompts/framing remain outside
// this measurable budget. Serialize every controlled input field, including schemas.
const BASE_OVERHEAD = 256;
const MESSAGE_OVERHEAD = 32;
const TOOL_OVERHEAD = 32;

export function controlledInputBudget(request: NormalizedEdgeRequest): number | undefined {
  if (request.operation.kind !== 'completion' || request.audioOutput !== undefined ||
      (request.input.format !== 'text' && request.input.format !== 'messages')) return undefined;
  if (request.input.format === 'messages' && request.input.messages.some((message) =>
    message.content.some((part) => part.type !== 'text'))) return undefined;
  const messages = request.input.format === 'messages' ? request.input.messages.length : 1;
  const payload = JSON.stringify({ input: request.input, tools: request.tools,
    toolChoice: request.toolChoice, responseFormat: request.responseFormat });
  return Buffer.byteLength(payload, 'utf8') + BASE_OVERHEAD +
    MESSAGE_OVERHEAD * messages + TOOL_OVERHEAD * request.tools.length;
}

export function pilotAllowsDeployment(
  pilot: InternalMeteredPilot,
  route: { readonly deploymentId: string; readonly modelReference: string; readonly provider: string }
): boolean {
  return pilot.deployments.some((allowed) => allowed.deploymentId === route.deploymentId &&
    allowed.modelReference === route.modelReference && allowed.provider === route.provider);
}
