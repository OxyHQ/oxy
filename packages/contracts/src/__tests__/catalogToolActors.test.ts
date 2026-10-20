import {
  appCapabilityCatalogSchema,
  CATALOG_TOOL_ACTOR_TYPES,
  CATALOG_TOOL_DEFAULT_ACTORS,
  catalogToolActors,
  catalogToolAllowsActor,
  catalogToolSchema,
  executionActorRefSchema,
} from '../index';

const readTool = {
  name: 'readViewerGraph',
  version: '1.0.0',
  description: 'Read the present subject relationship graph.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  capabilityPackage: 'read' as const,
  requiredCapabilities: ['user:read'],
  resourceTypes: ['account'],
  effect: 'read' as const,
  idempotency: 'none' as const,
  rollback: 'none' as const,
  exposure: ['internal' as const],
  invocation: { method: 'GET' as const, path: '/users/me/graph' },
};

const writeTool = {
  ...readTool,
  name: 'sendMessage',
  description: 'Send a message.',
  inputSchema: {
    type: 'object',
    required: ['text'],
    properties: { text: { type: 'string' } },
  },
  capabilityPackage: 'communicate' as const,
  requiredCapabilities: ['messages:write'],
  effect: 'write' as const,
  idempotency: 'required' as const,
  invocation: { method: 'POST' as const, path: '/messages' },
};

function catalog(tools: unknown[]) {
  return {
    schemaVersion: '1' as const,
    appId: 'oxy',
    version: '1.0.0',
    audience: 'oxy-platform-api',
    internalBaseUrl: 'https://api.oxy.so',
    accountResourceType: 'account',
    tools,
    events: [],
  };
}

describe('catalogue tool actors', () => {
  it('names exactly the executing actor types a ticket can carry', () => {
    const discriminators = executionActorRefSchema.options.map((option) => option.shape.type.value);
    expect([...CATALOG_TOOL_ACTOR_TYPES].sort()).toEqual([...discriminators].sort());
  });

  it('is optional: a catalogue without it parses unchanged and keeps no actors key', () => {
    const parsed = catalogToolSchema.parse(readTool);
    expect('actors' in parsed).toBe(false);
    expect(appCapabilityCatalogSchema.safeParse(catalog([readTool])).success).toBe(true);
  });

  it('accepts a declared subset and preserves it', () => {
    const parsed = catalogToolSchema.parse({ ...readTool, actors: ['requester'] });
    expect(parsed.actors).toEqual(['requester']);
    expect(
      appCapabilityCatalogSchema.parse(catalog([{ ...writeTool, actors: ['alia', 'agent'] }]))
        .tools[0]?.actors,
    ).toEqual(['alia', 'agent']);
  });

  it('refuses an empty, duplicated or unknown actor list', () => {
    for (const actors of [[], ['alia', 'alia'], ['owner'], ['requester', 'service'], 'alia'])
      expect(catalogToolSchema.safeParse({ ...readTool, actors }).success).toBe(false);
  });

  it('refuses a requester on a tool with an effect: requester tickets are read-only', () => {
    expect(catalogToolSchema.safeParse({ ...writeTool, actors: ['requester'] }).success).toBe(
      false,
    );
    expect(
      catalogToolSchema.safeParse({ ...writeTool, actors: ['alia', 'requester'] }).success,
    ).toBe(false);
    expect(catalogToolSchema.safeParse({ ...writeTool, actors: ['agent'] }).success).toBe(true);
  });

  it('stays strict: an unknown tool key is still refused', () => {
    expect(catalogToolSchema.safeParse({ ...readTool, executors: ['alia'] }).success).toBe(false);
  });

  it('keeps catalogue-level validation: overlapping invocations still fail with actors set', () => {
    const overlapping = catalog([
      {
        ...readTool,
        name: 'a',
        actors: ['requester'],
        invocation: { method: 'GET', path: '/x/{id}' },
        inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
      { ...readTool, name: 'b', actors: ['alia'], invocation: { method: 'GET', path: '/x/me' } },
    ]);
    expect(appCapabilityCatalogSchema.safeParse(overlapping).success).toBe(false);
  });

  it('reads an absent list as the standing actors only; a requester is opt-in', () => {
    expect(catalogToolActors(readTool)).toEqual(CATALOG_TOOL_DEFAULT_ACTORS);
    expect(catalogToolAllowsActor(readTool, 'alia')).toBe(true);
    expect(catalogToolAllowsActor(readTool, 'agent')).toBe(true);
    expect(catalogToolAllowsActor(readTool, 'requester')).toBe(false);

    const requesterOnly = { ...readTool, actors: ['requester' as const] };
    expect(catalogToolAllowsActor(requesterOnly, 'requester')).toBe(true);
    expect(catalogToolAllowsActor(requesterOnly, 'alia')).toBe(false);
    expect(catalogToolAllowsActor(requesterOnly, 'agent')).toBe(false);
  });
});
