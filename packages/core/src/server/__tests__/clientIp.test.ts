/**
 * `oxyTrustProxy` / `resolveClientIp` over a REAL socket.
 *
 * The question is what `req.ip` an Express app actually computes from the
 * header shapes the ALB and Cloudflare produce, so the app runs on an
 * ephemeral port (socket peer 127.0.0.1, standing in for the ALB) and every
 * case is also checked against `resolveClientIp`, which must agree with
 * Express on every chain.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  CLOUDFLARE_IPV4_RANGES,
  CLOUDFLARE_IPV6_RANGES,
  isCloudflareAddress,
  isPrivateProxyAddress,
  oxyTrustProxy,
  resolveClientIp,
} from '../clientIp';

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', oxyTrustProxy);
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip, resolved: resolveClientIp(req) });
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

function requestIp(forwardedFor?: string): Promise<{ ip: string; resolved: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/ip',
        headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve(JSON.parse(body)));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('req.ip behind the ALB and Cloudflare', () => {
  const cases: Array<[string, string | undefined, string]> = [
    ['no proxy header: the socket peer', undefined, '127.0.0.1'],
    ['grey: the address the ALB saw', '203.0.113.9', '203.0.113.9'],
    ['orange: the client Cloudflare saw, not its edge', '198.51.100.7, 172.70.1.2', '198.51.100.7'],
    ['orange, IPv6 client and edge', '2001:db8::1, 2606:4700:10::6816:1', '2001:db8::1'],
    [
      'orange: a forged entry left of the client is ignored',
      '6.6.6.6, 198.51.100.7, 172.70.1.2',
      '198.51.100.7',
    ],
    ['grey: a forged entry left of the client is ignored', '6.6.6.6, 198.51.100.7', '198.51.100.7'],
    [
      'grey: a forged Cloudflare address left of the client is not trusted',
      '172.70.1.2, 198.51.100.7',
      '198.51.100.7',
    ],
    [
      'only ONE Cloudflare hop is trusted (a Worker egress address is the client)',
      '6.6.6.6, 2a06:98c0:3600::103, 172.70.1.2',
      '2a06:98c0:3600::103',
    ],
    ['internal ALB: the caller in the VPC', '10.0.3.17', '10.0.3.17'],
  ];

  it.each(cases)('%s', async (_name, forwardedFor, expected) => {
    const { ip, resolved } = await requestIp(forwardedFor);
    expect(ip).toBe(expected);
    expect(resolved).toBe(expected);
  });
});

describe('resolveClientIp on a raw request', () => {
  it('believes no header when the socket peer is public (no proxy in front)', () => {
    expect(
      resolveClientIp({
        socket: { remoteAddress: '8.8.8.8' },
        headers: { 'x-forwarded-for': '1.2.3.4, 172.70.1.2' },
      }),
    ).toBe('8.8.8.8');
  });

  it('treats an IPv4-mapped private socket peer as the proxy', () => {
    expect(
      resolveClientIp({
        socket: { remoteAddress: '::ffff:10.0.1.5' },
        headers: { 'x-forwarded-for': '198.51.100.7, 162.158.4.4' },
      }),
    ).toBe('198.51.100.7');
  });

  it('joins repeated X-Forwarded-For headers in order', () => {
    expect(
      resolveClientIp({
        socket: { remoteAddress: '10.0.1.5' },
        headers: { 'x-forwarded-for': ['6.6.6.6', '198.51.100.7, 104.23.1.1'] } as never,
      }),
    ).toBe('198.51.100.7');
  });

  it('is undefined for a closed socket', () => {
    expect(resolveClientIp({ socket: null, headers: {} })).toBeUndefined();
  });
});

describe('address classes', () => {
  it('matches every published Cloudflare range at its network address', () => {
    for (const cidr of [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES]) {
      const network = cidr.slice(0, cidr.indexOf('/'));
      expect(isCloudflareAddress(network.endsWith('::') ? `${network}1` : network)).toBe(true);
    }
  });

  it('does not take neighbours or private space for Cloudflare', () => {
    expect(isCloudflareAddress('104.15.255.255')).toBe(false);
    expect(isCloudflareAddress('172.72.0.1')).toBe(false);
    expect(isCloudflareAddress('10.0.0.1')).toBe(false);
    expect(isCloudflareAddress('2606:4701::1')).toBe(false);
    expect(isCloudflareAddress('not-an-ip')).toBe(false);
  });

  it('classifies proxy peers', () => {
    for (const ip of [
      '10.0.0.1',
      '172.31.9.9',
      '192.168.1.1',
      '127.0.0.1',
      '::1',
      'fd00::5',
      '100.64.0.9',
    ]) {
      expect(isPrivateProxyAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.70.1.2', '2606:4700::1', '']) {
      expect(isPrivateProxyAddress(ip)).toBe(false);
    }
  });

  it('trusts hop 0 only when private and hop 1 only when Cloudflare', () => {
    expect(oxyTrustProxy('10.0.0.1', 0)).toBe(true);
    expect(oxyTrustProxy('8.8.8.8', 0)).toBe(false);
    expect(oxyTrustProxy('172.70.1.2', 1)).toBe(true);
    expect(oxyTrustProxy('10.0.0.1', 1)).toBe(false);
    expect(oxyTrustProxy('172.70.1.2', 2)).toBe(false);
  });
});
