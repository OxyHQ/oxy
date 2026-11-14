import { startEcosystemTraffic } from '../startTraffic';
import { createEcosystemTraffic } from '../traffic';

jest.mock('../traffic', () => ({ createEcosystemTraffic: jest.fn() }));

const create = createEcosystemTraffic as jest.MockedFunction<typeof createEcosystemTraffic>;
const stop = jest.fn(async () => undefined);
const installFetch = jest.fn();
const ready = () => true;

beforeEach(() => {
  jest.clearAllMocks();
  create.mockReturnValue({ stop, installFetch } as unknown as ReturnType<
    typeof createEcosystemTraffic
  >);
});

describe('startEcosystemTraffic', () => {
  it('publishes where a region is configured, passing the service, readiness and credentials through', () => {
    const workloadCredentials = jest.fn();
    const traffic = startEcosystemTraffic({
      service: 'allo',
      ready,
      workloadCredentials,
      baseURL: 'https://api.example.test',
      env: { AWS_REGION: 'us-west-2' },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'allo',
        ready,
        workloadCredentials,
        baseURL: 'https://api.example.test',
        region: 'us-west-2',
      }),
    );
    expect(installFetch).toHaveBeenCalledTimes(1);
    expect(traffic).toBe(create.mock.results[0]?.value);
  });

  it('falls back to AWS_DEFAULT_REGION', () => {
    startEcosystemTraffic({ service: 'nilo', ready, env: { AWS_DEFAULT_REGION: 'eu-west-1' } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ region: 'eu-west-1' }));
  });

  it('starts nothing without a region, and the handle it returns is inert', async () => {
    const traffic = startEcosystemTraffic({ service: 'allo', ready, env: {} });
    expect(create).not.toHaveBeenCalled();
    expect(installFetch).not.toHaveBeenCalled();
    const next = jest.fn();
    traffic.observeHttp({} as never, {} as never, next);
    traffic.middleware({} as never, {} as never, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(() =>
      traffic.record({ scope: 'internal', direction: 'inbound', activityType: 'platform' }),
    ).not.toThrow();
    const fetcher = jest.fn() as unknown as typeof fetch;
    expect(traffic.wrapFetch(fetcher)).toBe(fetcher);
    traffic.observeSocket({} as never)();
    traffic.observeWebSocket({} as never)();
    await expect(traffic.stop()).resolves.toBeUndefined();
  });

  it('lets OXY_ECOSYSTEM_ACTIVITY_ENABLED=false switch a configured region off', () => {
    startEcosystemTraffic({
      service: 'allo',
      ready,
      env: { AWS_REGION: 'us-west-2', OXY_ECOSYSTEM_ACTIVITY_ENABLED: 'false' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a flag that is neither true nor false', () => {
    expect(() =>
      startEcosystemTraffic({
        service: 'allo',
        ready,
        env: { AWS_REGION: 'us-west-2', OXY_ECOSYSTEM_ACTIVITY_ENABLED: 'yes' },
      }),
    ).toThrow('OXY_ECOSYSTEM_ACTIVITY_ENABLED must be true or false');
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to start without a region once the flag asks for it', () => {
    expect(() =>
      startEcosystemTraffic({
        service: 'allo',
        ready,
        env: { OXY_ECOSYSTEM_ACTIVITY_ENABLED: 'true' },
      }),
    ).toThrow('requires AWS_REGION');
    expect(create).not.toHaveBeenCalled();
  });

  describe('deployedOnly', () => {
    it('starts on a host that can attest its identity', () => {
      startEcosystemTraffic({
        service: 'mention',
        ready,
        deployedOnly: true,
        env: { AWS_REGION: 'us-west-2', AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/x' },
      });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('stays off where only a region is set (a developer shell)', () => {
      startEcosystemTraffic({
        service: 'mention',
        ready,
        deployedOnly: true,
        env: { AWS_REGION: 'us-west-2' },
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('is overridden by an explicit true', () => {
      startEcosystemTraffic({
        service: 'mention',
        ready,
        deployedOnly: true,
        env: { AWS_REGION: 'us-west-2', OXY_ECOSYSTEM_ACTIVITY_ENABLED: 'true' },
      });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('throws on a host that attests but has no region', () => {
      expect(() =>
        startEcosystemTraffic({
          service: 'mention',
          ready,
          deployedOnly: true,
          env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/x' },
        }),
      ).toThrow('requires AWS_REGION');
    });
  });

  it('never reads process.env when given an environment', () => {
    const before = process.env.AWS_REGION;
    process.env.AWS_REGION = 'us-west-2';
    try {
      startEcosystemTraffic({ service: 'allo', ready, env: {} });
      expect(create).not.toHaveBeenCalled();
    } finally {
      if (before === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = before;
    }
  });
});
