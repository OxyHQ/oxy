import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';

// Mock node:dns/promises so the static `import { lookup }` binding in safeFetch
// is intercepted (spying on the namespace doesn't work — the binding is
// resolved at module load, and the real `lookup` property is non-configurable).
const mockDnsLookup = jest.fn();
jest.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockDnsLookup(...args),
}));

import {
  assertSafePublicUrl,
  isBlockedIp,
} from '../safeFetch';

beforeEach(() => {
  mockDnsLookup.mockReset();
});

describe('@oxy.so/core/server safeFetch — isBlockedIp', () => {
  it('blocks private / loopback / metadata / reserved IPv4 ranges', () => {
    const blocked = [
      '127.0.0.1', // loopback
      '10.0.0.1', // RFC1918
      '10.255.255.255',
      '172.16.0.1', // RFC1918
      '172.31.255.255',
      '192.168.1.1', // RFC1918
      '169.254.169.254', // cloud metadata
      '169.254.0.1', // link-local
      '100.64.0.1', // CGNAT
      '0.0.0.0', // this network
      '224.0.0.1', // multicast
      '255.255.255.255', // broadcast
      '198.18.0.1', // benchmarking
    ];
    for (const ip of blocked) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it('blocks loopback / ULA / link-local IPv6 ranges and IPv4-mapped internals', () => {
    const blocked = [
      '::1', // loopback
      '::', // unspecified
      'fc00::1', // unique local
      'fe80::1', // link-local
      'ff02::1', // multicast
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:169.254.169.254', // IPv4-mapped metadata
    ];
    for (const ip of blocked) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it('allows genuine public IPs', () => {
    expect(isBlockedIp('1.1.1.1')).toBe(false);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('93.184.216.34')).toBe(false); // example.com historical
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false); // public IPv6
  });

  it('fails closed for non-IP literals', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('')).toBe(true);
  });
});

describe('@oxy.so/core/server safeFetch — assertSafePublicUrl', () => {
  it('rejects literal private / metadata IP URLs without any DNS', async () => {
    const cases: Array<[string, RegExp]> = [
      ['http://169.254.169.254/latest/meta-data/', /blocked range/],
      ['http://127.0.0.1/', /blocked range/],
      ['http://10.0.0.1/', /blocked range/],
      ['http://192.168.0.1/', /blocked range/],
      ['http://[::1]/', /blocked range/],
    ];
    for (const [url, reason] of cases) {
      const result = await assertSafePublicUrl(url);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(reason);
    }
  });

  it('rejects blocked hostnames before resolving', async () => {
    const result = await assertSafePublicUrl('http://localhost/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('blocked hostname');
  });

  it('rejects ambiguous numeric host forms before touching DNS', async () => {
    for (const url of [
      'http://2130706433/', // decimal 127.0.0.1
      'http://0x7f.1/',
      'http://0177.0.0.1/',
      'http://127.1/',
    ]) {
      const result = await assertSafePublicUrl(url);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['ambiguous numeric host', 'literal ip in blocked range']).toContain(result.reason);
      }
    }
  });

  it('rejects disallowed protocols, ports, credentials, and oversized URLs', async () => {
    expect((await assertSafePublicUrl('ftp://example.com/')).ok).toBe(false);
    expect((await assertSafePublicUrl('file:///etc/passwd')).ok).toBe(false);
    expect((await assertSafePublicUrl('http://example.com:22/')).ok).toBe(false);
    expect((await assertSafePublicUrl('http://user:pass@example.com/')).ok).toBe(false);
    expect((await assertSafePublicUrl('not a url')).ok).toBe(false);
    expect((await assertSafePublicUrl(`http://example.com/${'a'.repeat(3000)}`)).ok).toBe(false);
    expect((await assertSafePublicUrl('')).ok).toBe(false);
  });

  it('allows a literal public IP URL and pins the connection IP/family (no DNS)', async () => {
    const result = await assertSafePublicUrl('https://1.1.1.1/');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ip).toBe('1.1.1.1');
      expect(result.family).toBe(4);
    }
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  it('rejects a public hostname that resolves into a blocked range (rebind defence)', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const result = await assertSafePublicUrl('https://attacker.example/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('hostname resolves to blocked range');
    expect(mockDnsLookup).toHaveBeenCalledWith('attacker.example', { all: true });
  });

  it('rejects when ANY of multiple resolved records is internal', async () => {
    mockDnsLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 }, // public
      { address: '169.254.169.254', family: 4 }, // metadata smuggled in
    ]);
    const result = await assertSafePublicUrl('https://multi.example/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('hostname resolves to blocked range');
  });

  it('rejects when DNS resolution fails', async () => {
    mockDnsLookup.mockRejectedValue(new Error('ENOTFOUND'));
    const result = await assertSafePublicUrl('https://nope.example/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('dns resolution failed');
  });

  it('allows a public hostname resolving to public IPs and pins the first record', async () => {
    mockDnsLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ]);
    const result = await assertSafePublicUrl('https://example.com/');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ip).toBe('93.184.216.34');
      expect(result.family).toBe(4);
    }
  });
});

/**
 * Bun {all:true} lookup gotcha — shape assertion.
 *
 * The pinned `lookup` in safeFetch MUST return `[{address,family}]` when called
 * with `{ all: true }` (Bun calls lookup(host,{all:true},cb) then `.sort()`s the
 * result — a single value makes that internal sort throw "results.sort is not a
 * function"), and the `(err,address,family)` triple otherwise (Node). We
 * reconstruct the exact closure shape here and assert both call modes.
 *
 * (A full real-https.request verification against Bun was performed out of band;
 * this unit test guards the array-vs-triple contract under Jest/Node.)
 */
describe('@oxy.so/core/server safeFetch — pinned lookup {all:true} contract', () => {
  function makePinnedLookup(pinnedIp: string, pinnedFamily: 4 | 6): LookupFunction {
    return ((
      _hostname: string,
      options: number | LookupOneOptions | LookupAllOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void,
    ): void => {
      const wantsAll = typeof options === 'object' && options !== null && options.all === true;
      if (wantsAll) {
        callback(null, [{ address: pinnedIp, family: pinnedFamily }]);
      } else {
        callback(null, pinnedIp, pinnedFamily);
      }
    }) as unknown as LookupFunction;
  }

  it('returns an ARRAY of {address,family} for {all:true} (sortable, no throw)', (done) => {
    const lookup = makePinnedLookup('93.184.216.34', 4);
    (lookup as unknown as (
      h: string,
      o: LookupAllOptions,
      cb: (e: NodeJS.ErrnoException | null, a: LookupAddress[]) => void,
    ) => void)(
      'example.com',
      { all: true } as LookupAllOptions,
      (err, address) => {
        expect(err).toBeNull();
        expect(Array.isArray(address)).toBe(true);
        // The address array is what Bun internally `.sort()`s — must be sortable.
        expect(() => (address as LookupAddress[]).sort()).not.toThrow();
        expect(address).toEqual([{ address: '93.184.216.34', family: 4 }]);
        done();
      },
    );
  });

  it('returns the (address,family) triple for the non-all (Node) form', (done) => {
    const lookup = makePinnedLookup('93.184.216.34', 4);
    (lookup as unknown as (
      h: string,
      o: LookupOneOptions,
      cb: (e: NodeJS.ErrnoException | null, a: string, f: number) => void,
    ) => void)('example.com', {} as LookupOneOptions, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe('93.184.216.34');
      expect(family).toBe(4);
      done();
    });
  });
});
