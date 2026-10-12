import {
  type AppCapabilityCatalog,
  type CatalogTool,
  type CatalogToolActorType,
  catalogToolAllowsActor,
} from '@oxy.so/contracts';
import { RECOMMENDATION_SIGNALS } from '../utils/recommendationWeights';

/** One read-only Oxy domain definition; Inbox's separate catalogue is unchanged. */
export function oxyProfileCapabilityCatalog(): AppCapabilityCatalog {
  const base: Omit<CatalogTool, 'name' | 'description' | 'inputSchema' | 'invocation'> = {
    version: '1.0.0',
    capabilityPackage: 'read',
    requiredCapabilities: ['user:read'],
    resourceTypes: ['account'],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal'],
    // Only an app presenting its own signed-in user's session (ADR 0025): the
    // ranking and the graph are the PRESENT viewer's. Alia and agents are told
    // so by the catalogue and are refused by Oxy before a ticket exists.
    actors: ['requester'],
    limitKeys: [],
  };
  return {
    schemaVersion: '1',
    appId: 'oxy',
    // 1.1.0: tools declare `actors`.
    version: '1.1.0',
    audience: 'oxy-platform-api',
    internalBaseUrl: process.env.OXY_API_URL ?? 'https://api.oxy.so',
    accountResourceType: 'account',
    events: [],
    tools: [
      {
        ...base,
        name: 'recommendProfiles',
        description:
          'Rank profiles using the present viewer and verified presenting application private profile.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            clientId: { type: 'string', minLength: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
            excludeTypes: {
              type: 'array',
              items: { type: 'string', enum: ['federated', 'agent', 'automated'] },
            },
            excludeIds: { type: 'array', maxItems: 500, items: { type: 'string', minLength: 1 } },
            boosts: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['userIds', 'weight'],
                properties: {
                  userIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 200,
                    items: { type: 'string', minLength: 1 },
                  },
                  weight: { type: 'number', minimum: -5, maximum: 5 },
                  reason: { type: 'string', maxLength: 120 },
                },
              },
            },
            signalWeights: {
              type: 'object',
              additionalProperties: false,
              properties: Object.fromEntries(
                RECOMMENDATION_SIGNALS.map((signal) => [
                  signal,
                  { type: 'number', minimum: 0, maximum: 10 },
                ]),
              ),
            },
          },
        },
        invocation: { method: 'POST', path: '/_oxy/capabilities/profiles/recommendations' },
      },
      {
        ...base,
        name: 'readViewerGraph',
        description:
          'Read only the present subject relationship graph, including blocks and restrictions.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        invocation: { method: 'GET', path: '/_oxy/capabilities/users/me/graph' },
      },
    ],
  };
}

/**
 * The one answer to "may this actor execute this Oxy tool": the catalogue's own
 * declaration, read by the issuing authority, the MCP transport and the handler.
 */
export function oxyProfileToolAllowsActor(
  toolName: string,
  actorType: CatalogToolActorType,
): boolean {
  const tool = oxyProfileCapabilityCatalog().tools.find((entry) => entry.name === toolName);
  return tool !== undefined && catalogToolAllowsActor(tool, actorType);
}
