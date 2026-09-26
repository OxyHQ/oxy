import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';
import { OxyServer } from '../OxyServer';
import { OXY_ACCOUNT_DELETED_EVENT_URI, OxyAccountEventError } from '../middleware';

const b64url = (value: string | Uint8Array): string => Buffer.from(value).toString('base64url');

function sign(
  privateKey: KeyObject,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(signBytes(null, Buffer.from(signingInput), privateKey))}`;
}

const KID = 'oxy-service-test';

function eventToken(
  privateKey: KeyObject,
  overrides: { header?: Record<string, unknown>; payload?: Record<string, unknown>; event?: Record<string, unknown> } = {},
): string {
  return sign(
    privateKey,
    { alg: 'EdDSA', typ: 'secevent+jwt', kid: KID, ...overrides.header },
    {
      iss: 'oxy-auth',
      aud: 'app-mention',
      iat: 1_790_000_000,
      jti: '019a0000-0000-7000-8000-000000000001',
      events: {
        [OXY_ACCOUNT_DELETED_EVENT_URI]: {
          userId: 'user-deleted',
          username: 'qatest0925',
          occurredAt: '2026-09-26T09:14:00.000Z',
          retained: false,
          ...overrides.event,
        },
      },
      ...overrides.payload,
    },
  );
}

describe('verifyAccountEvent', () => {
  const oxyKey = generateKeyPairSync('ed25519');
  const strangerKey = generateKeyPairSync('ed25519');
  const jwk = { ...oxyKey.publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'EdDSA', kid: KID };

  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ keys: [jwk] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
  });
  afterEach(() => jest.restoreAllMocks());

  const client = () => new OxyServer({ baseURL: 'https://api.oxy.test' });

  it('returns the event from a genuine Oxy-signed token, verified against the public JWKS', async () => {
    const event = await client().accountEvents.verify(eventToken(oxyKey.privateKey), { audience: 'app-mention' });

    expect(event).toEqual({
      eventId: '019a0000-0000-7000-8000-000000000001',
      type: 'account.deleted',
      userId: 'user-deleted',
      username: 'qatest0925',
      occurredAt: '2026-09-26T09:14:00.000Z',
      retained: false,
      applicationId: 'app-mention',
      issuedAt: 1_790_000_000,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.oxy.test/.well-known/jwks.json',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it('reads a token without `username` (issued before the field existed) as username null', async () => {
    const token = eventToken(oxyKey.privateKey, { event: { username: undefined } });
    const event = await client().accountEvents.verify(token, { audience: 'app-mention' });
    expect(event.username).toBeNull();
  });

  it('carries `retained` through for an archived account', async () => {
    const token = eventToken(oxyKey.privateKey, { event: { retained: true } });
    await expect(client().accountEvents.verify(token, { audience: 'app-mention' }))
      .resolves.toMatchObject({ retained: true });
  });

  it('defaults the audience to the appId of the configured service credential', async () => {
    const oxy = client();
    const serviceToken = `${b64url(JSON.stringify({ alg: 'EdDSA' }))}.${b64url(JSON.stringify({ appId: 'app-mention' }))}.sig`;
    jest.spyOn(oxy, 'serviceToken').mockResolvedValue(serviceToken);

    await expect(oxy.accountEvents.verify(eventToken(oxyKey.privateKey))).resolves.toMatchObject({
      applicationId: 'app-mention',
    });
    await expect(oxy.accountEvents.verify(eventToken(oxyKey.privateKey, { payload: { aud: 'app-other' } })))
      .rejects.toThrow('addressed to another application');
  });

  const refusals: Array<[string, () => string, string]> = [
    ['a token signed by a key Oxy did not publish', () => eventToken(strangerKey.privateKey), 'signature is invalid'],
    ['a service token (typ JWT) replayed as an event', () => eventToken(oxyKey.privateKey, { header: { typ: 'JWT' } }), 'header is not supported'],
    ['a token for another application', () => eventToken(oxyKey.privateKey, { payload: { aud: 'app-other' } }), 'addressed to another application'],
    ['a token from another issuer', () => eventToken(oxyKey.privateKey, { payload: { iss: 'someone-else' } }), 'issuer is not Oxy'],
    ['a token without an event id', () => eventToken(oxyKey.privateKey, { payload: { jti: undefined } }), 'no event id'],
    ['a token with an unknown event', () => eventToken(oxyKey.privateKey, { payload: { events: { 'https://oxy.so/events/other': {} } } }), 'unknown event'],
    ['a token naming no account', () => eventToken(oxyKey.privateKey, { event: { userId: '' } }), 'names no account'],
    ['a token whose username is not a string', () => eventToken(oxyKey.privateKey, { event: { username: 42 } }), 'username is malformed'],
    ['a token with an unknown key id', () => eventToken(oxyKey.privateKey, { header: { kid: 'rotated-away' } }), 'unknown'],
  ];

  it.each(refusals)('refuses %s', async (_label, build, message) => {
    const attempt = client().accountEvents.verify(build(), { audience: 'app-mention' });
    await expect(attempt).rejects.toBeInstanceOf(OxyAccountEventError);
    await expect(client().accountEvents.verify(build(), { audience: 'app-mention' })).rejects.toThrow(message);
  });

  it('refuses a tampered payload', async () => {
    const [header, , signature] = eventToken(oxyKey.privateKey).split('.');
    const forged = b64url(JSON.stringify({
      iss: 'oxy-auth',
      aud: 'app-mention',
      iat: 1,
      jti: 'x',
      events: { [OXY_ACCOUNT_DELETED_EVENT_URI]: { userId: 'someone-else', occurredAt: '2026-09-26T00:00:00Z' } },
    }));
    await expect(client().accountEvents.verify(`${header}.${forged}.${signature}`, { audience: 'app-mention' }))
      .rejects.toThrow('signature is invalid');
  });

  it('refuses garbage without fetching keys', async () => {
    await expect(client().accountEvents.verify('not-a-token', { audience: 'app-mention' }))
      .rejects.toThrow('not a compact JWS');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('listAccountEvents', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads the pull feed with the service token and passes the cursor', async () => {
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.test' });
    jest.spyOn(oxy, 'serviceToken').mockResolvedValue('service-token');
    const page = { events: [], nextCursor: 'cursor-1' };
    const request = jest.spyOn(oxy, 'request').mockResolvedValue(page as never);

    await expect(oxy.accountEvents.list({ after: 'cursor-1', limit: 50 })).resolves.toEqual(page);
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/account-events',
      { after: 'cursor-1', limit: '50' },
      expect.objectContaining({ cache: false, headers: { Authorization: 'Bearer service-token' } }),
    );
  });
});
