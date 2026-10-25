import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { coldLaunchTargetFromUrl } from '@/lib/cold-launch/target';

/**
 * The cold-launch replay is the only thing that gets a deep link past the
 * routing gate on a cold start. A card link used to fall outside it, so
 * cold-launching one opened the ID tab and dropped the card.
 */
describe('coldLaunchTargetFromUrl', () => {
  const did = 'did:web:oxy.so:u:0123456789abcdef01234567';

  it('replays a shared Oxy ID card link to the card screen, every scheme', () => {
    const payload = `oxycommons://card?did=${encodeURIComponent(did)}&v=1`;
    for (const url of [payload, payload.replace(/^oxycommons:/, 'commons:')]) {
      expect(coldLaunchTargetFromUrl(url)).toEqual({
        pathname: '/(tabs)/(id)/card/[did]',
        params: { did },
      });
    }
  });

  it('accepts the already rewritten path form', () => {
    expect(coldLaunchTargetFromUrl(`oxycommons:///card/${encodeURIComponent(did)}`)).toEqual({
      pathname: '/(tabs)/(id)/card/[did]',
      params: { did },
    });
  });

  it('drops a card link with no usable did', () => {
    expect(coldLaunchTargetFromUrl('oxycommons://card?v=1')).toBeNull();
    expect(coldLaunchTargetFromUrl('oxycommons://card?did=&v=1')).toBeNull();
  });

  it('still replays approvals and attestations, with decoded params', () => {
    expect(coldLaunchTargetFromUrl('oxycommons://approve?code=a%2Fb')).toEqual({
      pathname: '/approve',
      params: { code: 'a/b' },
    });
    expect(coldLaunchTargetFromUrl('commons://attest?subject=x')).toEqual({
      pathname: '/(scan)/attest',
      params: { subject: 'x' },
    });
  });

  it('keeps a malformed param raw rather than dropping the intent', () => {
    expect(coldLaunchTargetFromUrl('oxycommons://approve?code=%E0%A4%A')).toEqual({
      pathname: '/approve',
      params: { code: '%E0%A4%A' },
    });
  });

  it('ignores anything else', () => {
    expect(coldLaunchTargetFromUrl('oxycommons://settings')).toBeNull();
    expect(coldLaunchTargetFromUrl('')).toBeNull();
  });

  it('the root layout replays the card with navigate, so it is never opened twice', () => {
    const layout = readFileSync(resolve(__dirname, '../../app/_layout.tsx'), 'utf8');
    expect(layout).toMatch(/coldLaunchTargetFromUrl\(url\)/);
    expect(layout).toMatch(/router\.navigate\(target\)/);
  });
});
