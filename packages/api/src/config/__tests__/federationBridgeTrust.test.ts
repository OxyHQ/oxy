/**
 * API-side bridge trust — which operators this service will let a connector
 * re-attribute an account to. Deliberately separate from an app's
 * `createBridgeRelabeller([...])` entries; both lists fail closed in both
 * directions.
 */

import {
  FEDERATION_BRIDGE_TRUST,
  bridgeVouchesForNetwork,
} from '../federationBridgeTrust';

describe('FEDERATION_BRIDGE_TRUST', () => {
  it('names each bridge host once', () => {
    const hosts = FEDERATION_BRIDGE_TRUST.map((entry) => entry.host);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it.each(
    FEDERATION_BRIDGE_TRUST.map((entry) => [entry.host, entry.networkDomain] as const),
  )('%s vouches for %s', (host, networkDomain) => {
    expect(bridgeVouchesForNetwork(host, networkDomain)).toBe(true);
  });
});

describe('bridgeVouchesForNetwork', () => {
  it('refuses a listed bridge claiming a network it does not mirror', () => {
    expect(bridgeVouchesForNetwork('bird.makeup', 'instagram.com')).toBe(false);
    expect(bridgeVouchesForNetwork('kilogram.makeup', 'x.com')).toBe(false);
    expect(bridgeVouchesForNetwork('bsky.brid.gy', 'x.com')).toBe(false);
  });

  it('refuses an unlisted host', () => {
    expect(bridgeVouchesForNetwork('mastodon.social', 'x.com')).toBe(false);
    expect(bridgeVouchesForNetwork('evil-bridge.example', 'x.com')).toBe(false);
  });

  it('compares hosts canonically, so case and a www. prefix cannot slip past', () => {
    expect(bridgeVouchesForNetwork('BIRD.MAKEUP', 'X.COM')).toBe(true);
    expect(bridgeVouchesForNetwork('www.bird.makeup', 'x.com')).toBe(true);
    expect(bridgeVouchesForNetwork('bird.makeup', 'WWW.X.COM')).toBe(true);
  });

  it('refuses empty or blank hosts and domains', () => {
    expect(bridgeVouchesForNetwork('', 'x.com')).toBe(false);
    expect(bridgeVouchesForNetwork('bird.makeup', '')).toBe(false);
    expect(bridgeVouchesForNetwork('   ', 'x.com')).toBe(false);
  });
});
