/** @jest-environment node */

// Only the native browser transport is simulated. Metadata, token exchange and
// profile reads use the real OxyServices/HttpService against an owned HTTP server.
jest.mock('../../components/oauthNavigation', () => ({
  openAuthorizeUrlNative: jest.fn(),
  redirectToAuthorize: jest.fn(),
}));

import { createServer, type Server } from 'node:http';
import { OxyServices } from '@oxy.so/core';
import { openAuthorizeUrlNative } from '../../components/oauthNavigation';
import { requestOAuthConsent } from '../explicitOAuthConsent';

const PERSON = '01a0646a-078f-7000-8000-000000000001';
const ORGANIZATION = '01a0646a-078f-7000-8000-000000000002';
const CLIENT = 'oxy_dk_fixture';
const REDIRECT = 'fixture://oauth/consent';
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 300;
function token(subject: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ userId: subject, exp: EXPIRES_AT })}.fixture`;
}

describe('OAuth bearer commit with real HTTP transport', () => {
  let server: Server;
  let oxy: OxyServices;
  let exchangeSubject: string;
  let exchanges: number;
  let profileSubjects: string[];
  let unexpectedRequests: string[];
  let visibleSubject: string;
  const openNative = jest.mocked(openAuthorizeUrlNative);

  beforeEach(async () => {
    exchangeSubject = ORGANIZATION;
    exchanges = 0;
    profileSubjects = [];
    unexpectedRequests = [];
    visibleSubject = PERSON;
    openNative.mockReset();
    openNative.mockImplementation(async (authorizeUrl) => {
      const state = new URL(authorizeUrl).searchParams.get('state');
      return { redirectUrl: `${REDIRECT}?code=owned-code&state=${state}` };
    });
    server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === `/auth/oauth/client/${CLIENT}`) {
        res.end(JSON.stringify({ application: { id: 'fixture-app', scopes: ['user:read'] } }));
      } else if (req.method === 'POST' && req.url === '/auth/oauth/token') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const params = new URLSearchParams(body);
        expect(params.get('client_id')).toBe(CLIENT);
        expect(params.get('redirect_uri')).toBe(REDIRECT);
        expect(params.get('code_verifier')).toBeTruthy();
        exchanges += 1;
        res.end(
          JSON.stringify({
            access_token: token(exchangeSubject),
            session_id: 'fixture-session',
            expires_in: 300,
            user: {
              id: exchangeSubject,
              username: exchangeSubject === PERSON ? 'fixture-person' : 'fixture-organization',
            },
          }),
        );
      } else if (req.method === 'GET' && req.url === '/users/me') {
        const bearer = req.headers.authorization;
        const subject =
          bearer === `Bearer ${token(PERSON)}`
            ? PERSON
            : bearer === `Bearer ${token(ORGANIZATION)}`
              ? ORGANIZATION
              : null;
        if (!subject) {
          res.statusCode = 401;
          res.end(JSON.stringify({ message: 'Unauthorized' }));
          return;
        }
        profileSubjects.push(subject);
        res.end(
          JSON.stringify({
            id: subject,
            username: subject === PERSON ? 'fixture-person' : 'fixture-organization',
          }),
        );
      } else {
        unexpectedRequests.push(`${req.method} ${req.url}`);
        res.statusCode = 500;
        res.end(JSON.stringify({ message: 'Unexpected fixture request' }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned HTTP listener missing');
    oxy = new OxyServices({
      baseURL: `http://127.0.0.1:${address.port}`,
      enableCache: false,
      maxRetries: 0,
    });
    oxy.session.setAccessToken(token(PERSON));
  });

  afterEach(async () => {
    oxy?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(unexpectedRequests).toEqual([]);
  });

  async function consent() {
    return requestOAuthConsent(
      {
        platform: 'native',
        mode: 'popup',
        oxyServices: oxy,
        clientId: CLIENT,
        identityBound: false,
        expectedUserId: PERSON,
        commitSession: async (session) => {
          if (!session.accessToken) throw new Error('Fixture commit requires bearer');
          oxy.session.setAccessToken(session.accessToken);
          visibleSubject = session.userId;
        },
      },
      { redirectUri: REDIRECT, scopes: ['user:read'] },
    );
  }

  it('rejects a different returned subject without replacing the previous bearer', async () => {
    const previous = oxy.session.accessToken;
    expect(await consent()).toEqual({ status: 'failed', reason: 'subject-mismatch' });
    expect(exchanges).toBe(1);
    expect(visibleSubject).toBe(PERSON);
    oxy.cache.clear();
    expect((await oxy.users.me()).id).toBe(PERSON);
    expect(profileSubjects).toEqual([PERSON]);
    expect(oxy.session.accessToken).toBe(previous);
  });

  it('commits a matching subject and its new bearer after validation', async () => {
    exchangeSubject = PERSON;
    const changes: (string | null)[] = [];
    const unsubscribe = oxy.session.onChange((value) => changes.push(value));
    expect(await consent()).toEqual({ status: 'consented' });
    unsubscribe();
    expect(exchanges).toBe(1);
    expect(changes).toEqual([token(PERSON)]);
    expect((await oxy.users.me()).id).toBe(PERSON);
  });

  it('cancels before exchange and retains the bearer', async () => {
    openNative.mockResolvedValue({ redirectUrl: null });
    expect(await consent()).toEqual({ status: 'cancelled' });
    expect(exchanges).toBe(0);
    expect((await oxy.users.me()).id).toBe(PERSON);
  });

  it('preserves legacy direct exchange planting by default', async () => {
    await oxy.auth.oauth.exchangeCode({
      code: 'owned-code',
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: 'fixture-verifier',
    });
    expect(exchanges).toBe(1);
    expect((await oxy.users.me()).id).toBe(ORGANIZATION);
  });
});
