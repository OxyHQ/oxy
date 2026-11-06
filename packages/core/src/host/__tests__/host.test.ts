import {
  OXY_SESSION_HOST_CONTRACT,
  getOxySessionHost,
  registerOxySessionHost,
  type OxySessionHost,
} from '../index';

const KEY = Symbol.for('oxy.so/session-host');

function host(overrides: Partial<Record<keyof OxySessionHost, unknown>> = {}): OxySessionHost {
  return {
    contract: 1,
    platform: 'oxyos',
    snapshot: () => ({ status: 'signed_out', revision: 0, account: null, online: true }),
    subscribe: () => () => undefined,
    getAccessToken: async () => null,
    request: async () => undefined,
    ...overrides,
  } as OxySessionHost;
}

afterEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[KEY];
});

describe('@oxy.so/core/host', () => {
  it('speaks contract 1', () => {
    expect(OXY_SESSION_HOST_CONTRACT).toBe(1);
  });

  it('finds nothing when no host is registered', () => {
    expect(getOxySessionHost()).toBeNull();
  });

  it('returns the registered host', () => {
    const registered = host();
    registerOxySessionHost(registered);
    expect(getOxySessionHost()).toEqual({ host: registered });
  });

  it('registers once: a second registration throws and keeps the first', () => {
    const first = host();
    registerOxySessionHost(first);
    expect(() => registerOxySessionHost(host({ platform: 'astro' }))).toThrow(/already registered/);
    expect(getOxySessionHost()).toEqual({ host: first });
  });

  it('cannot be replaced by assignment', () => {
    const first = host();
    registerOxySessionHost(first);
    expect(() => {
      (globalThis as unknown as Record<symbol, unknown>)[KEY] = host();
    }).toThrow(TypeError);
    expect(getOxySessionHost()).toEqual({ host: first });
  });

  it('agrees with another copy of the SDK through the global symbol', () => {
    const registered = host();
    // Another copy of core (the runtime's) writes the same well-known slot.
    Object.defineProperty(globalThis, Symbol.for('oxy.so/session-host'), {
      value: registered,
      configurable: true,
    });
    expect(getOxySessionHost()).toEqual({ host: registered });
    expect(() => registerOxySessionHost(host())).toThrow(/already registered/);
  });

  it.each([
    ['another contract', { contract: 2 }],
    ['an unknown platform', { platform: 'windows' }],
    ['a missing method', { getAccessToken: undefined }],
  ])('reports an unknown contract for %s', (_name, overrides) => {
    Object.defineProperty(globalThis, KEY, { value: host(overrides), configurable: true });
    expect(getOxySessionHost()).toEqual({ unknownContract: true });
  });

  it('reports an unknown contract for something that is not a host', () => {
    Object.defineProperty(globalThis, KEY, { value: 'host', configurable: true });
    expect(getOxySessionHost()).toEqual({ unknownContract: true });
  });

  it('refuses to register a non-object', () => {
    expect(() => registerOxySessionHost(null as unknown as OxySessionHost)).toThrow(TypeError);
    expect(getOxySessionHost()).toBeNull();
  });
});
