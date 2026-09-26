/**
 * `GET /.well-known/webfinger`.
 *
 * The case that matters most is the instance actor. Mastodon resolves the owner
 * of a signing key by WebFinger before trusting it, so when `acct:instance@oxy.so`
 * answered 404, every signed fetch Oxy made against an authorized-fetch server
 * (mastodon.social among them) came back 401 "Webfinger error when resolving
 * instance@oxy.so", and no external actor on those servers could be verified.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { createWebfingerHandler } from '../webfinger';

interface FakeUser {
  username: string;
  federatable: boolean;
}

const USERS: FakeUser[] = [
  { username: 'nate', federatable: true },
  { username: 'hidden', federatable: false },
];

const findUserByUsername = jest.fn(async (username: string) => USERS.find((user) => user.username === username));
const logger = { error: jest.fn() };

let server: http.Server;

function get(path: string): Promise<{ status: number; contentType?: string; body: Record<string, unknown> }> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: address.port, path }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        contentType: res.headers['content-type'],
        body: JSON.parse(raw) as Record<string, unknown>,
      }));
    }).on('error', reject);
  });
}

beforeAll((done) => {
  const app = express();
  app.get('/.well-known/webfinger', createWebfingerHandler<FakeUser>({
    domain: 'oxy.so',
    isOwnFederationDomain: (domain) => domain === 'oxy.so' || domain === 'api.oxy.so',
    findUserByUsername,
    isFederatableUser: (user) => user.federatable,
    logger,
  }));
  server = app.listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  findUserByUsername.mockClear();
  logger.error.mockClear();
});

describe('GET /.well-known/webfinger', () => {
  it('resolves the instance actor that signs outbound fetches', async () => {
    const res = await get('/.well-known/webfinger?resource=acct:instance@oxy.so');

    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/^application\/jrd\+json/);
    expect(res.body).toEqual({
      subject: 'acct:instance@oxy.so',
      links: [{ rel: 'self', type: 'application/activity+json', href: 'https://oxy.so/ap/users/instance' }],
    });
    // Never looked up as a person: a user named `instance` cannot claim it.
    expect(findUserByUsername).not.toHaveBeenCalled();
  });

  it('answers the instance actor on the canonical domain when asked on another served domain', async () => {
    const res = await get('/.well-known/webfinger?resource=acct:Instance@api.oxy.so');

    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('acct:instance@oxy.so');
  });

  it('resolves a federatable user with their actor and profile page', async () => {
    const res = await get('/.well-known/webfinger?resource=acct:Nate@oxy.so');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      subject: 'acct:nate@oxy.so',
      links: [
        { rel: 'self', type: 'application/activity+json', href: 'https://oxy.so/ap/users/nate' },
        { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: 'https://oxy.so/@nate' },
      ],
    });
  });

  it('404s a user who is not federatable, and one who does not exist', async () => {
    expect((await get('/.well-known/webfinger?resource=acct:hidden@oxy.so')).status).toBe(404);
    expect((await get('/.well-known/webfinger?resource=acct:nobody@oxy.so')).status).toBe(404);
  });

  it('404s a domain Oxy does not serve, even for the instance actor', async () => {
    const res = await get('/.well-known/webfinger?resource=acct:instance@mastodon.social');

    expect(res.status).toBe(404);
  });

  it('400s a resource that is not an acct: URI, or has no domain', async () => {
    expect((await get('/.well-known/webfinger?resource=https://oxy.so/ap/users/instance')).status).toBe(400);
    expect((await get('/.well-known/webfinger')).status).toBe(400);
    expect((await get('/.well-known/webfinger?resource=acct:instance')).status).toBe(400);
  });

  it('500s, and logs, when the user lookup throws', async () => {
    findUserByUsername.mockRejectedValueOnce(new Error('db down'));

    const res = await get('/.well-known/webfinger?resource=acct:nate@oxy.so');

    expect(res.status).toBe(500);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
