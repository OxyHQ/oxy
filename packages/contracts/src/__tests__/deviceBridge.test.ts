import {
  deviceProofSchema,
  deviceRegisterResponseSchema,
  deviceJoinCodeRequestSchema,
  deviceJoinCodeResponseSchema,
  deviceJoinRequestSchema,
  deviceJoinResponseSchema,
  webauthnLoginVerifyRequestSchema,
  webauthnRegisterVerifyRequestSchema,
} from '../index';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('the browser bridge contracts (ADR 0029 D2)', () => {
  it('a device proof is an id and a secret', () => {
    expect(deviceProofSchema.safeParse({ deviceId: 'd1', deviceSecret: 's1' }).success).toBe(true);
    expect(deviceProofSchema.safeParse({ deviceId: 'd1' }).success).toBe(false);
    expect(deviceProofSchema.safeParse({ deviceId: '', deviceSecret: 's1' }).success).toBe(false);
  });

  it('register and join answer a device credential', () => {
    const credential = { deviceId: 'd1', deviceSecret: 's1' };
    expect(deviceRegisterResponseSchema.parse(credential)).toEqual(credential);
    expect(deviceJoinResponseSchema.parse(credential)).toEqual(credential);
  });

  it('a join-code request is PKCE S256 only', () => {
    const request = {
      deviceId: 'd1',
      deviceSecret: 's1',
      clientId: 'oxy_dk_1',
      redirectUri: 'https://mention.earth/',
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
    };
    expect(deviceJoinCodeRequestSchema.safeParse(request).success).toBe(true);
    expect(deviceJoinCodeRequestSchema.safeParse({ ...request, codeChallengeMethod: 'plain' }).success).toBe(false);
    expect(deviceJoinCodeRequestSchema.safeParse({ ...request, codeChallenge: 'short' }).success).toBe(false);
    expect(deviceJoinCodeRequestSchema.safeParse({ ...request, redirectUri: 'not a url' }).success).toBe(false);
  });

  it('a join-code response carries the code and its lifetime', () => {
    expect(deviceJoinCodeResponseSchema.safeParse({ code: 'c', expiresIn: 60 }).success).toBe(true);
    expect(deviceJoinCodeResponseSchema.safeParse({ code: 'c', expiresIn: 0 }).success).toBe(false);
  });

  it('a join request carries an RFC 7636 verifier', () => {
    const request = { code: 'c', codeVerifier: VERIFIER, clientId: 'oxy_dk_1', redirectUri: 'https://mention.earth/' };
    expect(deviceJoinRequestSchema.safeParse(request).success).toBe(true);
    expect(deviceJoinRequestSchema.safeParse({ ...request, codeVerifier: 'short' }).success).toBe(false);
    expect(deviceJoinRequestSchema.safeParse({ ...request, codeVerifier: `${VERIFIER}!` }).success).toBe(false);
  });

  it('passkey sign-ins may carry a device proof', () => {
    const device = { deviceId: 'd1', deviceSecret: 's1' };
    expect(webauthnLoginVerifyRequestSchema.parse({ device }).device).toEqual(device);
    expect(webauthnRegisterVerifyRequestSchema.parse({ device }).device).toEqual(device);
    expect(webauthnLoginVerifyRequestSchema.parse({}).device).toBeUndefined();
    expect(webauthnLoginVerifyRequestSchema.safeParse({ device: { deviceId: 'd1' } }).success).toBe(false);
  });
});
