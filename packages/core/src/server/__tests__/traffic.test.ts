import { createEcosystemTraffic } from '../traffic';

/**
 * Every client the publisher builds, so a test can ask what it was handed.
 *
 * Named `mock*` because ts-jest hoists `jest.mock` above the imports and only
 * lets a factory close over a binding with that prefix.
 */
const mockClients: Array<{ configureServiceAuth: jest.Mock; getServiceToken: jest.Mock }> = [];

jest.mock('../../OxyServices', () => ({
  OxyServices: jest.fn(() => {
    const client = {
      configureServiceAuth: jest.fn(),
      getServiceToken: jest.fn(async () => 'token-from-workload'),
    };
    mockClients.push(client);
    return client;
  }),
}));

function lastClient() {
  const client = mockClients[mockClients.length - 1];
  if (!client) throw new Error('No OxyServices was built.');
  return client;
}

/** Accepts every publish and remembers the headers, so nothing reaches a network. */
function recordingFetch(sent: RequestInit[]) {
  return jest.fn(async (_input, init) => {
    sent.push(init as RequestInit);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
}

function authorizations(sent: RequestInit[]): string[] {
  return sent.map(init => (init.headers as Record<string, string>).Authorization);
}

/**
 * A process with nothing configured and nothing to attest: a laptop.
 *
 * Emptied by assignment rather than `delete`, which Biome refuses on a property
 * access — and `= undefined` would be worse than either, because Node stores the
 * STRING "undefined" and every check here would read it as a configured value.
 */
function clearCredentialEnvironment() {
  process.env.OXY_ACTIVITY_API_KEY = '';
  process.env.OXY_ACTIVITY_API_SECRET = '';
  process.env.OXY_SERVICE_API_KEY = '';
  process.env.OXY_SERVICE_API_SECRET = '';
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '';
  process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = '';
}

beforeEach(() => {
  mockClients.length = 0;
});

it('publishes independently of viewers and waits for registration before removing a stopped instance', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown> | unknown[]> = [];
  let releaseRegistration!: () => void;
  const registration = new Promise<void>(resolve => { releaseRegistration = resolve; });
  let registered!: () => void;
  const registrationStarted = new Promise<void>(resolve => { registered = resolve; });
  globalThis.fetch = jest.fn(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (!Array.isArray(body) && !body.removed) {
      registered();
      await registration;
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const traffic = createEcosystemTraffic({ service: 'mention', region: 'us-west-2', credential: async () => 'test-service-token', ready: () => true });
  try {
    await registrationStarted;
    traffic.record({ scope: 'internal', direction: 'outbound', activityType: 'communication', sourceRegion: 'us-west-2', targetRegion: 'us-west-2', targetService: 'oxy-api' });
    const stopped = traffic.stop();
    expect(bodies.some(body => !Array.isArray(body) && body.removed === true)).toBe(false);
    releaseRegistration();
    await stopped;
    expect(bodies[bodies.length - 1]).toMatchObject({ removed: true, service: 'mention', status: 'online' });
    expect(bodies.find(Array.isArray)).toEqual([expect.objectContaining({ service: 'mention', scope: 'internal', direction: 'outbound', requests: 1 })]);
  } finally {
    releaseRegistration();
    await traffic.stop();
    globalThis.fetch = originalFetch;
  }
});

it('rejects a partial activity credential instead of mixing it with service credentials', () => {
  const previous = { ...process.env };
  try {
    process.env.OXY_ACTIVITY_API_KEY = 'activity-key';
    delete process.env.OXY_ACTIVITY_API_SECRET;
    process.env.OXY_SERVICE_API_KEY = 'service-key';
    process.env.OXY_SERVICE_API_SECRET = 'service-secret';
    expect(() => createEcosystemTraffic({ service: 'homiio', region: 'us-west-2' })).toThrow('complete OXY_ACTIVITY');
  } finally {
    process.env = previous;
  }
});

/**
 * Who may publish ecosystem activity, and who is still refused.
 *
 * ADR 0026 made "no api key, no secret" a legitimate shape for a first-party
 * service: it attests its ECS task role instead. This constructor used to throw
 * on exactly that shape, so the migration it asks for — delete two variables
 * from a task definition — killed the process at boot, the circuit breaker
 * rolled the deploy back, and the operator was told the service was stable.
 */
describe('ecosystem activity credentials', () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    process.env = { ...previous };
    globalThis.fetch = originalFetch;
  });

  it('uses a service key pair when the process holds one', async () => {
    clearCredentialEnvironment();
    process.env.OXY_SERVICE_API_KEY = 'service-key';
    process.env.OXY_SERVICE_API_SECRET = 'service-secret';
    const sent: RequestInit[] = [];
    globalThis.fetch = recordingFetch(sent);

    const traffic = createEcosystemTraffic({ service: 'mention', region: 'us-west-2' });
    await traffic.stop();

    expect(lastClient().configureServiceAuth).toHaveBeenCalledWith('service-key', 'service-secret');
    expect(lastClient().getServiceToken).toHaveBeenCalled();
  });

  it('lets an explicit credential win over the environment', async () => {
    clearCredentialEnvironment();
    process.env.OXY_SERVICE_API_KEY = 'service-key';
    process.env.OXY_SERVICE_API_SECRET = 'service-secret';
    const sent: RequestInit[] = [];
    globalThis.fetch = recordingFetch(sent);

    const traffic = createEcosystemTraffic({ service: 'mention', region: 'us-west-2', credential: async () => 'explicit-token' });
    await traffic.stop();

    expect(authorizations(sent)).not.toContain('Bearer token-from-workload');
    expect(authorizations(sent)).toContain('Bearer explicit-token');
    expect(lastClient().getServiceToken).not.toHaveBeenCalled();
  });

  it('refuses a process with no credential and nothing to attest', () => {
    clearCredentialEnvironment();

    // A laptop or a CI box: the container credentials endpoint is not going to
    // appear later, so saying so at boot beats failing on the first heartbeat.
    expect(() => createEcosystemTraffic({ service: 'homiio', region: 'us-west-2' })).toThrow(
      /needs one of: an OXY_ACTIVITY_API_KEY and OXY_ACTIVITY_API_SECRET pair, an OXY_SERVICE_API_KEY and OXY_SERVICE_API_SECRET pair, or a workload identity/
    );
  });

  it('publishes with no key pair at all when the process can attest its workload identity', async () => {
    clearCredentialEnvironment();
    // The variable ECS sets on every task, and nothing else does. Stubbed, so
    // `canAttestWorkloadIdentity()` answers yes without a credentials endpoint.
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc';
    const sent: RequestInit[] = [];
    globalThis.fetch = recordingFetch(sent);

    const traffic = createEcosystemTraffic({ service: 'mention', region: 'us-west-2' });
    await traffic.stop();

    // Unconfigured on purpose: that is what sends `getServiceToken()` down the
    // workload path instead of handing it half a credential.
    expect(lastClient().configureServiceAuth).not.toHaveBeenCalled();
    expect(lastClient().getServiceToken).toHaveBeenCalled();
    expect(authorizations(sent)).toContain('Bearer token-from-workload');
  });
});
