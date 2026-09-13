import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
const mockSafeFetch = jest.fn();
jest.mock('@oxy.so/core/server', () => ({ safeFetch: (...args: unknown[]) => mockSafeFetch(...args) }));
import { fetchMetaFirstPartyProfilePair, parseMetaFirstPartyProfile } from '../metaFirstPartyProof.service';
const fixture = (name: string) => readFileSync(join(__dirname, '../__fixtures__/meta-profile-proof', name), 'utf8');
const ig = fixture('instagram-zuck.html');
const th = fixture('threads-zuck.html');
const igUrl = 'https://www.instagram.com/zuck/';
const thUrl = 'https://www.threads.com/@zuck';
function response(html: string, finalUrl: string, status = 200) {
  return { response: Readable.from([Buffer.from(html)]), finalUrl, status, headers: { 'content-type': 'text/html; charset=utf-8' } };
}
beforeEach(() => { mockSafeFetch.mockReset(); });
it('reads the captured owner namespaces and profile-control badges', () => {
  expect(parseMetaFirstPartyProfile(ig, 'zuck@instagram.com')).toMatchObject({ pk: '314216', id: '17841401746480004', displayName: 'Mark Zuckerberg', badgeTargetAcct: 'zuck@threads.net' });
  expect(parseMetaFirstPartyProfile(th, 'zuck@threads.net')).toMatchObject({ pk: '63055343223', id: '63055343223', badgeTargetAcct: 'zuck@instagram.com' });
});
it('verifies fresh reciprocal first-party pages without equating numeric namespaces', async () => {
  mockSafeFetch.mockResolvedValueOnce(response(ig, igUrl)).mockResolvedValueOnce(response(th, thUrl));
  const result = await fetchMetaFirstPartyProfilePair({ sourceAcct: 'zuck@instagram.com' });
  expect(result).toMatchObject({ status: 'verified', pair: { instagram: { pk: '314216', graphId: '17841401746480004' }, threads: { webPk: '63055343223' } } });
  expect(mockSafeFetch).toHaveBeenNthCalledWith(1, igUrl, expect.objectContaining({ maxRedirects: 0, headersTimeoutMs: 10000, signal: expect.any(AbortSignal) }));
  expect(mockSafeFetch).toHaveBeenNthCalledWith(2, thUrl, expect.any(Object));
  expect(JSON.stringify(result)).not.toContain('application/json');
});
it('discovers a differently named counterpart from the source badge', async () => {
  const first = ig.replace('threads.com/@zuck', 'threads.com/@other');
  const second = th.replaceAll('/@zuck', '/@other').replace('"username":"zuck"', '"username":"other"');
  mockSafeFetch.mockResolvedValueOnce(response(first, igUrl)).mockResolvedValueOnce(response(second, 'https://www.threads.com/@other'));
  expect(await fetchMetaFirstPartyProfilePair({ sourceAcct: 'zuck@instagram.com' })).toMatchObject({ status: 'verified', pair: { threads: { canonicalAcct: 'other@threads.net' } } });
});
it('supports fresh discovery starting at Threads', async () => {
  mockSafeFetch.mockResolvedValueOnce(response(th, thUrl)).mockResolvedValueOnce(response(ig, igUrl));
  expect(await fetchMetaFirstPartyProfilePair({ sourceAcct: 'zuck@threads.com' })).toMatchObject({ status: 'verified' });
});
it('rejects a nonreciprocal badge or an expected-counterpart mismatch', async () => {
  mockSafeFetch.mockResolvedValueOnce(response(ig, igUrl)).mockResolvedValueOnce(response(th.replace('instagram.com/zuck/', 'instagram.com/other/'), thUrl));
  expect(await fetchMetaFirstPartyProfilePair({ sourceAcct: 'zuck@instagram.com' })).toMatchObject({ status: 'refused', reason: 'nonreciprocal_badges' });
  mockSafeFetch.mockReset().mockResolvedValueOnce(response(ig, igUrl));
  expect(await fetchMetaFirstPartyProfilePair({ sourceAcct: 'zuck@instagram.com', expectedCounterpartAcct: 'other@threads.net' })).toMatchObject({ status: 'refused', reason: 'nonreciprocal_badges' });
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
});
it.each([['instagram.com', ig], ['threads.net', th]])('rejects a bare biography link without platform controls on %s', (network, html) => {
  const unbranded = html.replace(/<svg aria-label="(?:Threads|Instagram)" role="img"><\/svg>/, '<span>My other account</span>');
  expect(() => parseMetaFirstPartyProfile(unbranded, `zuck@${network}`)).toThrow('missing_profile_badge');
});
it.each([['instagram.com', ig], ['threads.net', th]])('rejects a copied branded badge moved into biography or navigation on %s', (network, html) => {
  const badge = html.match(/<a href="https:\/\/www\.(?:threads|instagram)\.com\/[^>]+>[\s\S]*?<\/a>/)?.[0];
  expect(badge).toBeDefined();
  if (!badge) throw new Error('Fixture badge missing');
  const removed = html.replace(badge, '');
  const bio = removed.replace(/(<span>)(I build stuff|Mostly superintelligence and MMA takes)/, `$1${badge}$2`);
  expect(() => parseMetaFirstPartyProfile(bio, `zuck@${network}`)).toThrow('missing_profile_badge');
  expect(() => parseMetaFirstPartyProfile(removed.replace('</body>', `<nav>${badge}</nav></body>`), `zuck@${network}`)).toThrow('missing_profile_badge');
});
it('rejects a timeline badge in place of the Threads profile footer', () => {
  const badge = th.match(/<a href="https:\/\/www\.instagram\.com\/[^>]+>[\s\S]*?<\/a>/)?.[0];
  if (!badge) throw new Error('Fixture badge missing');
  const html = th.replace(badge, '').replace('data-pagelet="threads_profile_posts_timeline_0">', `data-pagelet="threads_profile_posts_timeline_0">${badge}`);
  expect(() => parseMetaFirstPartyProfile(html, 'zuck@threads.net')).toThrow('missing_profile_badge');
});
it('rejects multiple owned badges', () => {
  const badge = th.match(/<a href="https:\/\/www\.instagram\.com\/[^>]+>[\s\S]*?<\/a>/)?.[0];
  if (!badge) throw new Error('Fixture badge missing');
  const duplicatedPanel = th.match(/<div role="region"[\s\S]*?<script/)?.[0].replace(/<script$/, '');
  if (!duplicatedPanel) throw new Error('Fixture panel missing');
  expect(() => parseMetaFirstPartyProfile(th.replace('<script', `${duplicatedPanel}<script`), 'zuck@threads.net')).toThrow('ambiguous_profile_badge');
});
it('rejects missing, unrelated, and conflicting root owners', () => {
  expect(() => parseMetaFirstPartyProfile(ig.replace('PolarisLoggedOutDesktopWWWProfileRootContentQuery', 'UnrelatedPostAuthorQuery'), 'zuck@instagram.com')).toThrow('missing_profile_owner');
  expect(() => parseMetaFirstPartyProfile(ig.replace('"username":"zuck"', '"username":"other"'), 'zuck@instagram.com')).toThrow('profile_mismatch');
  const script = ig.match(/<script[\s\S]*?<\/script>/i)?.[0];
  if (!script) throw new Error('Fixture source payload missing');
  expect(() => parseMetaFirstPartyProfile(ig.replace('</body>', script.replace('"pk":"314216"', '"pk":"999"') + '</body>'), 'zuck@instagram.com')).toThrow('ambiguous_profile_owner');
});
it('rejects login walls, deceptive canonical URLs and private profiles', () => {
  expect(() => parseMetaFirstPartyProfile('<html><body>Log in</body></html>', 'zuck@instagram.com')).toThrow('profile_mismatch');
  expect(() => parseMetaFirstPartyProfile(ig.replace('www.instagram.com/zuck/', 'www.instagram.com.evil.example/zuck/'), 'zuck@instagram.com')).toThrow('profile_mismatch');
  expect(() => parseMetaFirstPartyProfile(ig.replace('"is_private":false', '"is_private":true'), 'zuck@instagram.com')).toThrow('missing_profile_owner');
});
it('does not execute source scripts and requires inert JSON payloads', () => {
  expect(() => parseMetaFirstPartyProfile(ig.replace('type="application/json"', 'type="text/javascript"'), 'zuck@instagram.com')).toThrow('missing_profile_owner');
  expect(parseMetaFirstPartyProfile(ig.replace('</body>', '<script>throw new Error("never execute")</script></body>'), 'zuck@instagram.com').pk).toBe('314216');
});
it('fails closed for redirects, rate limits, body limits and invalid account inputs', async () => {
  mockSafeFetch.mockResolvedValueOnce(response(ig, 'https://login.example/', 200));
  expect(await fetchMetaFirstPartyProfilePair({ sourceAcct: 'zuck@instagram.com' })).toMatchObject({ status: 'refused', reason: 'upstream_unavailable' });
  mockSafeFetch.mockResolvedValueOnce(response('', igUrl, 429));
  expect(await fetchMetaFirstPartyProfilePair({ sourceAcct: 'zuck@instagram.com' })).toMatchObject({ status: 'refused', reason: 'upstream_unavailable' });
  mockSafeFetch.mockResolvedValueOnce(response('x'.repeat(2 * 1024 * 1024 + 1), igUrl));
  expect(await fetchMetaFirstPartyProfilePair({ sourceAcct: 'zuck@instagram.com' })).toMatchObject({ status: 'refused', reason: 'oversized_document' });
  mockSafeFetch.mockClear();
  expect(await fetchMetaFirstPartyProfilePair({ sourceAcct: 'zuck@instagram.com.evil.example' })).toMatchObject({ status: 'refused', reason: 'invalid_account' });
  expect(mockSafeFetch).not.toHaveBeenCalled();
});

it('timestamps the observation before the first fetch so late results cannot supersede newer revocations', async () => {
  let firstFetchAt = 0;
  mockSafeFetch.mockImplementationOnce(async () => {
    firstFetchAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 5));
    return response(ig, igUrl);
  }).mockResolvedValueOnce(response(th, thUrl));
  const result = await fetchMetaFirstPartyProfilePair({ sourceAcct: 'zuck@instagram.com' });
  expect(result.status).toBe('verified');
  if (result.status === 'verified') expect(Date.parse(result.pair.fetchedAt)).toBeLessThanOrEqual(firstFetchAt);
});
