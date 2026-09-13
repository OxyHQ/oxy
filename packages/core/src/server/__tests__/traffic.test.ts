import { createEcosystemTraffic } from '../traffic';

jest.mock('../../OxyServices', () => ({ OxyServices: jest.fn(() => ({})) }));

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
