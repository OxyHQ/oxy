import { createEcosystemTraffic } from '../traffic';

/**
 * Every client the publisher builds, so a test can ask what it was handed.
 *
 * Named `mock*` because ts-jest hoists `jest.mock` above the imports and only
 * lets a factory close over a binding with that prefix.
 */
const mockClients: Array<{
  configureServiceAuth: jest.Mock;
  serviceRequest: jest.Mock;
  dispose: jest.Mock;
}> = [];

jest.mock('../OxyServer', () => ({
  OxyServer: jest.fn(() => {
    const client = {
      configureServiceAuth: jest.fn(),
      dispose: jest.fn(),
      serviceRequest: jest.fn(async (_method, path, data) => {
        const response = await globalThis.fetch(`https://api.oxy.so${path}`, {
          method: 'POST',
          headers: { Authorization: 'Bearer token-from-workload' },
          body: JSON.stringify(data),
        });
        if (!response.ok) throw new Error('Activity collection failed');
      }),
    };
    mockClients.push(client);
    return client;
  }),
}));

function lastClient() {
  const client = mockClients[mockClients.length - 1];
  if (!client) throw new Error('No OxyServer was built.');
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
  return sent.map((init) => (init.headers as Record<string, string>).Authorization);
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
  const registration = new Promise<void>((resolve) => {
    releaseRegistration = resolve;
  });
  let registered!: () => void;
  const registrationStarted = new Promise<void>((resolve) => {
    registered = resolve;
  });
  globalThis.fetch = jest.fn(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (!Array.isArray(body) && !body.removed) {
      registered();
      await registration;
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const traffic = createEcosystemTraffic({
    service: 'mention',
    region: 'us-west-2',
    credential: async () => 'test-service-token',
    ready: () => true,
  });
  try {
    await registrationStarted;
    traffic.record({
      scope: 'internal',
      direction: 'outbound',
      activityType: 'communication',
      sourceRegion: 'us-west-2',
      targetRegion: 'us-west-2',
      targetService: 'oxy-api',
    });
    const stopped = traffic.stop();
    expect(bodies.some((body) => !Array.isArray(body) && body.removed === true)).toBe(false);
    releaseRegistration();
    await stopped;
    expect(bodies[bodies.length - 1]).toMatchObject({
      removed: true,
      service: 'mention',
      status: 'online',
    });
    expect(bodies.find(Array.isArray)).toEqual([
      expect.objectContaining({
        service: 'mention',
        scope: 'internal',
        direction: 'outbound',
        requests: 1,
      }),
    ]);
  } finally {
    releaseRegistration();
    await traffic.stop();
    globalThis.fetch = originalFetch;
  }
});

describe('ecosystem activity credentials', () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    process.env = { ...previous };
    globalThis.fetch = originalFetch;
  });

  it('ignores ambient legacy key pairs for its own workload publisher', async () => {
    clearCredentialEnvironment();
    process.env.OXY_SERVICE_API_KEY = 'service-key';
    process.env.OXY_SERVICE_API_SECRET = 'service-secret';
    const sent: RequestInit[] = [];
    globalThis.fetch = recordingFetch(sent);

    const traffic = createEcosystemTraffic({ service: 'mention', region: 'us-west-2' });
    await traffic.stop();

    expect(lastClient().configureServiceAuth).not.toHaveBeenCalled();
    expect(lastClient().serviceRequest).toHaveBeenCalled();
  });

  it('lets an explicit credential win over the environment', async () => {
    clearCredentialEnvironment();
    process.env.OXY_SERVICE_API_KEY = 'service-key';
    process.env.OXY_SERVICE_API_SECRET = 'service-secret';
    const sent: RequestInit[] = [];
    globalThis.fetch = recordingFetch(sent);

    const traffic = createEcosystemTraffic({
      service: 'mention',
      region: 'us-west-2',
      credential: async () => 'explicit-token',
    });
    await traffic.stop();

    expect(authorizations(sent)).not.toContain('Bearer token-from-workload');
    expect(authorizations(sent)).toContain('Bearer explicit-token');
    expect(lastClient().serviceRequest).not.toHaveBeenCalled();
  });

  it('accepts an injected temporary credential provider without an ECS environment', async () => {
    clearCredentialEnvironment();
    const sent: RequestInit[] = [];
    globalThis.fetch = recordingFetch(sent);
    const provider = async () => ({
      AccessKeyId: 'ASIATEST',
      SecretAccessKey: 'test',
      Token: 'temporary',
    });
    const traffic = createEcosystemTraffic({
      service: 'homiio',
      region: 'us-west-2',
      workloadCredentials: provider,
    });
    await traffic.stop();
    const { OxyServer } = await import('../OxyServer');
    expect(OxyServer).toHaveBeenLastCalledWith({
      baseURL: 'https://api.oxy.so',
      workloadCredentials: provider,
    });
    expect(lastClient().serviceRequest).toHaveBeenCalled();
    expect(lastClient().dispose).toHaveBeenCalledTimes(1);
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

    // No environment credential pair is configured on the own workload client.
    expect(lastClient().configureServiceAuth).not.toHaveBeenCalled();
    expect(lastClient().serviceRequest).toHaveBeenCalled();
    expect(authorizations(sent)).toContain('Bearer token-from-workload');
  });
});

it('backs off a refused publisher, reports the outage once, and recovers when Oxy accepts again', async () => {
  jest.useFakeTimers();
  const originalFetch = globalThis.fetch;
  let refuse = true;
  const attempts: string[] = [];
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
    attempts.push(String(input));
    return new Response(null, { status: refuse ? 403 : 204 });
  }) as unknown as typeof fetch;
  const onError = jest.fn();
  const onRecover = jest.fn();
  try {
    const traffic = createEcosystemTraffic({
      service: 'tnp-relay',
      region: 'us-west-2',
      credential: async () => 'token',
      onError,
      onRecover,
    });
    // A minute of the old cadence: a flush every 2 s and a heartbeat every 10 s.
    for (let second = 0; second < 60; second += 1) {
      traffic.record({ scope: 'internal', direction: 'outbound', activityType: 'platform' });
      await jest.advanceTimersByTimeAsync(1_000);
    }
    // 2 s, 4 s, 8 s, 16 s, 32 s ceilings (jittered between half and all of
    // each): at most a handful of attempts, against ~36 before.
    expect(attempts.length).toBeLessThanOrEqual(8);
    expect(onError).toHaveBeenCalledTimes(1);

    refuse = false;
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(onRecover).toHaveBeenCalledTimes(1);
    await traffic.stop();
  } finally {
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
  }
});
