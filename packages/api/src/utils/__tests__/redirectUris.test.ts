import {
  computeOfficialRedirectUriRepair,
  includesRedirectUri,
  originOfWebsiteUrl,
} from '../redirectUris';

describe('computeOfficialRedirectUriRepair', () => {
  it('returns null when the website origin is the complete allowlist', () => {
    expect(
      computeOfficialRedirectUriRepair(
        ['https://oxy.so'],
        'https://oxy.so/about',
      ),
    ).toBeNull();
  });

  it('replaces stale entries with the canonical website origin', () => {
    expect(
      computeOfficialRedirectUriRepair(
        ['https://fairco.in'],
        'https://oxy.so',
      ),
    ).toEqual(['https://oxy.so']);
  });

  it('removes extra entries even when the website origin is already present', () => {
    expect(
      computeOfficialRedirectUriRepair(
        ['https://oxy.so', 'https://stale.example/callback'],
        'https://oxy.so/about',
      ),
    ).toEqual(['https://oxy.so']);
  });

  it('seeds the origin when redirectUris is empty', () => {
    expect(computeOfficialRedirectUriRepair([], 'https://crowdsource.oxy.so')).toEqual([
      'https://crowdsource.oxy.so',
    ]);
  });

  it('returns null for invalid website URLs', () => {
    expect(computeOfficialRedirectUriRepair(['https://a.example'], 'not-a-url')).toBeNull();
  });
});

describe('includesRedirectUri', () => {
  it('matches exact entries only', () => {
    expect(includesRedirectUri(['https://a.example'], 'https://a.example')).toBe(true);
    expect(includesRedirectUri(['https://a.example'], 'https://a.example/')).toBe(false);
  });
});

describe('originOfWebsiteUrl', () => {
  it('extracts the origin from a full URL', () => {
    expect(originOfWebsiteUrl('https://console.oxy.so/settings')).toBe('https://console.oxy.so');
  });
});
