/**
 * RFC 6749 §2.3 client-authentication parsing.
 *
 * These rules decide WHICH credential the token endpoint will test, so a bug
 * here is an authentication bug even though no secret is verified in this file:
 * silently reading the client id from the wrong place, or letting a request
 * carry two contradictory identities, would let a caller aim the (correct)
 * secret comparison at a credential they do not own.
 */

import { resolveClientAuthentication } from '../oauthClientAuth';
import { OAuthError } from '../oauthResponse';

const CLIENT_ID = 'oxy_dk_abc123';
const CLIENT_SECRET = 'hexsecret0123456789';

function basic(userid: string, password: string): string {
  return `Basic ${Buffer.from(`${userid}:${password}`).toString('base64')}`;
}

describe('resolveClientAuthentication', () => {
  it('reads client_secret_post credentials from the body', () => {
    expect(
      resolveClientAuthentication({
        authorizationHeader: undefined,
        bodyClientId: CLIENT_ID,
        bodyClientSecret: CLIENT_SECRET,
      }),
    ).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });

  it('resolves a public (PKCE) client that authenticates with nothing', () => {
    expect(
      resolveClientAuthentication({
        authorizationHeader: undefined,
        bodyClientId: CLIENT_ID,
        bodyClientSecret: undefined,
      }),
    ).toEqual({ clientId: CLIENT_ID, clientSecret: undefined });
  });

  it('decodes client_secret_basic credentials', () => {
    expect(
      resolveClientAuthentication({
        authorizationHeader: basic(CLIENT_ID, CLIENT_SECRET),
        bodyClientId: undefined,
        bodyClientSecret: undefined,
      }),
    ).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });

  it('accepts the scheme name case-insensitively (RFC 7235 §2.1)', () => {
    const header = basic(CLIENT_ID, CLIENT_SECRET).replace('Basic', 'basic');

    expect(
      resolveClientAuthentication({
        authorizationHeader: header,
        bodyClientId: undefined,
        bodyClientSecret: undefined,
      }),
    ).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });

  it('form-urldecodes both halves, as §2.3.1 requires', () => {
    // A secret containing characters that MUST be encoded before base64.
    const encodedId = encodeURIComponent('client id');
    const encodedSecret = encodeURIComponent('p@ss:word/+=');

    expect(
      resolveClientAuthentication({
        authorizationHeader: basic(encodedId, encodedSecret),
        bodyClientId: undefined,
        bodyClientSecret: undefined,
      }),
    ).toEqual({ clientId: 'client id', clientSecret: 'p@ss:word/+=' });
  });

  it('splits on the FIRST colon so a secret may contain colons (RFC 7617 §2)', () => {
    expect(
      resolveClientAuthentication({
        authorizationHeader: basic(CLIENT_ID, 'a%3Ab%3Ac'),
        bodyClientId: undefined,
        bodyClientSecret: undefined,
      }),
    ).toEqual({ clientId: CLIENT_ID, clientSecret: 'a:b:c' });
  });

  it('accepts a body client_id that agrees with the Basic header', () => {
    expect(
      resolveClientAuthentication({
        authorizationHeader: basic(CLIENT_ID, CLIENT_SECRET),
        bodyClientId: CLIENT_ID,
        bodyClientSecret: undefined,
      }),
    ).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });

  it('rejects two authentication methods in one request (§2.3)', () => {
    expect(() =>
      resolveClientAuthentication({
        authorizationHeader: basic(CLIENT_ID, CLIENT_SECRET),
        bodyClientId: undefined,
        bodyClientSecret: CLIENT_SECRET,
      }),
    ).toThrow(expect.objectContaining({ error: 'invalid_request' }));
  });

  it('rejects a body client_id that contradicts the Basic header', () => {
    expect(() =>
      resolveClientAuthentication({
        authorizationHeader: basic(CLIENT_ID, CLIENT_SECRET),
        bodyClientId: 'oxy_dk_someone_else',
        bodyClientSecret: undefined,
      }),
    ).toThrow(expect.objectContaining({ error: 'invalid_request' }));
  });

  it('rejects an authentication scheme it does not implement', () => {
    expect(() =>
      resolveClientAuthentication({
        authorizationHeader: 'Bearer some.jwt.token',
        bodyClientId: CLIENT_ID,
        bodyClientSecret: undefined,
      }),
    ).toThrow(expect.objectContaining({ error: 'invalid_client' }));
  });

  it('rejects a Basic payload with no colon separator', () => {
    expect(() =>
      resolveClientAuthentication({
        authorizationHeader: `Basic ${Buffer.from('no-separator-here').toString('base64')}`,
        bodyClientId: undefined,
        bodyClientSecret: undefined,
      }),
    ).toThrow(expect.objectContaining({ error: 'invalid_client' }));
  });

  it('rejects a malformed percent-escape rather than guessing at the credential', () => {
    expect(() =>
      resolveClientAuthentication({
        authorizationHeader: basic('%zz', CLIENT_SECRET),
        bodyClientId: undefined,
        bodyClientSecret: undefined,
      }),
    ).toThrow(expect.objectContaining({ error: 'invalid_client' }));
  });

  it('normalises an empty Basic half to undefined', () => {
    expect(
      resolveClientAuthentication({
        authorizationHeader: basic(CLIENT_ID, ''),
        bodyClientId: undefined,
        bodyClientSecret: undefined,
      }),
    ).toEqual({ clientId: CLIENT_ID, clientSecret: undefined });
  });

  it('throws OAuthError instances, so the route renders them as RFC documents', () => {
    expect(() =>
      resolveClientAuthentication({
        authorizationHeader: 'Digest username="x"',
        bodyClientId: undefined,
        bodyClientSecret: undefined,
      }),
    ).toThrow(OAuthError);
  });
});
