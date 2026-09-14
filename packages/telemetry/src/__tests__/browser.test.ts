import { createBrowserTelemetry } from '../browser';

describe('browser telemetry', () => {
  it('rotates an ephemeral activity id without persistence', () => {
    let now = 1_000;
    let sequence = 0;
    const telemetry = createBrowserTelemetry({
      location: { hostname: 'mention.earth', protocol: 'https:' } as Location,
      now: () => now,
      crypto: {
        randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
        getRandomValues: crypto.getRandomValues.bind(crypto),
      },
      activityIdRotationMs: 100,
    });

    const first = telemetry.getActivityIdHeader()['X-Oxy-Activity-Id'];
    expect(telemetry.getActivityIdHeader()['X-Oxy-Activity-Id']).toBe(first);
    now += 100;
    expect(telemetry.getActivityIdHeader()['X-Oxy-Activity-Id']).not.toBe(first);
  });

  it('extracts only the Cloudflare serving PoP and caches discovery', async () => {
    const fetchTrace = jest.fn(async () => ({
      ok: true,
      text: async () => 'ip=203.0.113.8\ncolo=MAD\nloc=ES',
    }));
    const telemetry = createBrowserTelemetry({
      location: { hostname: 'alia.onl', protocol: 'https:' } as Location,
      fetchTrace,
    });

    await expect(telemetry.getEdgeRegionHeader()).resolves.toEqual({ 'X-Oxy-Edge-Region': 'mad' });
    await telemetry.getEdgeRegionHeader();
    expect(fetchTrace).toHaveBeenCalledTimes(1);
  });

  it('does not query trace from loopback', async () => {
    const fetchTrace = jest.fn();
    const telemetry = createBrowserTelemetry({
      location: { hostname: 'localhost', protocol: 'http:' } as Location,
      fetchTrace,
    });
    await expect(telemetry.getEdgeRegionHeader()).resolves.toEqual({});
    expect(fetchTrace).not.toHaveBeenCalled();
  });
  it('rediscovers the edge after a VPN change without reloading the page', async () => {
    let now = 1_000;
    let edge = 'MAD';
    const fetchTrace = jest.fn(async () => ({ ok: true, text: async () => `colo=${edge}\nip=203.0.113.8\nloc=ES` }));
    const telemetry = createBrowserTelemetry({ location: { hostname: 'oxy.so', protocol: 'https:' }, now: () => now, fetchTrace });
    await expect(telemetry.getEdgeRegionHeader()).resolves.toEqual({ 'X-Oxy-Edge-Region': 'mad' });
    edge = 'NRT';
    now += 15_000;
    await expect(telemetry.getEdgeRegionHeader()).resolves.toEqual({ 'X-Oxy-Edge-Region': 'nrt' });
    expect(fetchTrace).toHaveBeenCalledTimes(2);
  });

  it('retries failed discovery on the next window instead of caching failure for the session', async () => {
    let now = 1_000;
    const fetchTrace = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, text: async () => 'colo=SYD' });
    const telemetry = createBrowserTelemetry({ location: { hostname: 'oxy.so', protocol: 'https:' }, now: () => now, fetchTrace });
    await expect(telemetry.getEdgeRegionHeader()).resolves.toEqual({});
    now += 15_000;
    await expect(telemetry.getEdgeRegionHeader()).resolves.toEqual({ 'X-Oxy-Edge-Region': 'syd' });
  });

});
