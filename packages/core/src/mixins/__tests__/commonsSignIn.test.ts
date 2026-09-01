/**
 * "Sign in with Oxy" handoff tests (Workstream C).
 *
 * Stubs `makeRequest` (and the shared challenge/sign primitives) so the tests
 * run with no network. We assert the exact request bodies the RP and the
 * approver send — these are the load-bearing coordination points with the C2
 * server endpoints — plus the native-vs-web behaviour of the shared-key SSO.
 *
 * Also covers Phase 4 (automatic delivery, issue #691): push-token
 * registration, the bearer-authenticated `deliver` call, the un-authenticated
 * `opened` progress signal, and the pure route selector — including the
 * degrade-to-QR behaviour every ambiguous input must produce.
 */

import type { CommonsDenyReason } from '@oxyhq/contracts';
import { COMMONS_DENY_REASONS } from '@oxyhq/contracts';
import type { SessionLoginResponse } from '../../models/session';
import type { ChallengeResponse } from '../OxyServices.auth';
import type { CommonsDeliveryPlatform } from '../../utils/commonsDelivery';
import { OxyServices } from '../../OxyServices';
import { KeyManager } from '../../crypto/keyManager';
import { SignatureService } from '../../crypto/signatureService';
import { selectCommonsDelivery, pushTargetsFromDelivery } from '../../utils/commonsDelivery';

const challengeFixture: ChallengeResponse = {
  challenge: 'chal-xyz',
  expiresAt: '2026-06-26T00:05:00.000Z',
};

const sessionFixture: SessionLoginResponse = {
  sessionId: 's1',
  deviceId: 'd1',
  expiresAt: '2026-06-26T00:05:00.000Z',
  accessToken: 'at-1',
  user: { id: 'u1', username: 'nate', name: { displayName: 'Nate' } },
};

describe('OxyServices — "Sign in with Oxy" handoff', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequestSpy = jest.spyOn(oxy, 'makeRequest');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('startCommonsSignIn (relying party)', () => {
    it('generates a client-side sessionToken and POSTs /auth/session/create', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('secret-session-token');
      makeRequestSpy.mockResolvedValue({
        authorizeCode: 'code-1',
        qrPayload: 'oxycommons://approve?v=1&code=code-1',
        status: 'pending',
        expiresAt: 1700000300000,
      });

      const handle = await oxy.startCommonsSignIn({ clientId: 'oxy_dk_test' });

      // expiry is client-proposed (now + 5 min) on the request...
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/auth/session/create',
        { sessionToken: 'secret-session-token', expiresAt: 1700000300000, clientId: 'oxy_dk_test' },
        expect.objectContaining({ cache: false, skipAuth: true }),
      );
      // ...and the handle carries the SECRET token + the server's public code/payload.
      expect(handle).toEqual({
        sessionToken: 'secret-session-token',
        authorizeCode: 'code-1',
        qrPayload: 'oxycommons://approve?v=1&code=code-1',
        expiresAt: 1700000300000,
        status: 'pending',
      });
      // The secret token must never leak into the QR payload.
      expect(handle.qrPayload).not.toContain('secret-session-token');
    });

    it('omits the oauth key entirely when no OAuth binding is given (body byte-identical to a plain device sign-in)', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('tok');
      makeRequestSpy.mockResolvedValue({
        authorizeCode: 'code-1',
        qrPayload: 'oxycommons://approve?v=1&code=code-1',
        status: 'pending',
      });

      await oxy.startCommonsSignIn({ clientId: 'oxy_dk_test' });

      // `toHaveBeenCalledWith` ignores explicitly-undefined keys, so assert the
      // literal key set: the server decides the request's purpose from the
      // PRESENCE of `oauth`, and an `oauth: undefined` key would still serialize
      // differently from the body this endpoint has always received.
      const body = makeRequestSpy.mock.calls[0][2];
      expect(Object.keys(body)).toEqual(['sessionToken', 'expiresAt', 'clientId']);
    });

    it('sends the OAuth binding verbatim when provided', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('secret-session-token');
      makeRequestSpy.mockResolvedValue({
        authorizeCode: 'code-oauth',
        qrPayload: 'oxycommons://approve?v=1&code=code-oauth',
        status: 'pending',
      });

      const oauth = {
        redirectUri: 'https://mention.earth',
        codeChallenge: 'chal-s256',
        codeChallengeMethod: 'S256' as const,
        scope: 'openid profile',
        subjectAccountId: 'acct-org',
      };

      const handle = await oxy.startCommonsSignIn({ clientId: 'oxy_dk_test', oauth });

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/auth/session/create',
        {
          sessionToken: 'secret-session-token',
          expiresAt: 1700000300000,
          clientId: 'oxy_dk_test',
          oauth,
        },
        expect.objectContaining({ cache: false, skipAuth: true }),
      );
      // The PKCE verifier and the secret token never leave the initiator, and
      // the QR still only carries the public code.
      expect(JSON.stringify(makeRequestSpy.mock.calls[0][2])).not.toContain('codeVerifier');
      expect(handle.qrPayload).not.toContain('secret-session-token');
    });

    it('carries an OAuth binding without a scope or delegated account unchanged', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('tok');
      makeRequestSpy.mockResolvedValue({
        authorizeCode: 'code-oauth',
        qrPayload: 'oxycommons://approve?v=1&code=code-oauth',
        status: 'pending',
      });

      await oxy.startCommonsSignIn({
        clientId: 'oxy_dk_test',
        oauth: {
          redirectUri: 'https://mention.earth',
          codeChallenge: 'chal-s256',
          codeChallengeMethod: 'S256',
        },
      });

      expect(makeRequestSpy.mock.calls[0][2].oauth).toEqual({
        redirectUri: 'https://mention.earth',
        codeChallenge: 'chal-s256',
        codeChallengeMethod: 'S256',
      });
    });

    it('falls back to the client-proposed expiry when the server omits it', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      jest.spyOn(SignatureService, 'generateChallenge').mockResolvedValue('tok');
      makeRequestSpy.mockResolvedValue({
        authorizeCode: 'code-2',
        qrPayload: 'oxycommons://approve?v=1&code=code-2',
        status: 'pending',
      });

      const handle = await oxy.startCommonsSignIn({ clientId: 'oxy_dk_test' });
      expect(handle.expiresAt).toBe(1700000000000 + 5 * 60 * 1000);
    });
  });

  describe('pollCommonsSignIn (relying party)', () => {
    it('GETs the session status without cache/retry', async () => {
      makeRequestSpy.mockResolvedValue({ authorized: true, sessionId: 's1' });

      const result = await oxy.pollCommonsSignIn('secret-session-token');

      // Delivery progress degrades to null on a server that reports none.
      expect(result).toEqual({
        authorized: true,
        sessionId: 's1',
        purpose: 'device_sign_in',
        pushSentAt: null,
        openedAt: null,
      });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/auth/session/status/secret-session-token',
        undefined,
        expect.objectContaining({ cache: false, retry: false }),
      );
    });

    it('carries delivery progress timestamps through unchanged', async () => {
      makeRequestSpy.mockResolvedValue({
        authorized: false,
        status: 'pending',
        pushSentAt: '2026-07-27T10:00:00.000Z',
        openedAt: '2026-07-27T10:00:12.000Z',
      });

      const result = await oxy.pollCommonsSignIn('secret-session-token');

      expect(result).toEqual({
        authorized: false,
        status: 'pending',
        purpose: 'device_sign_in',
        pushSentAt: '2026-07-27T10:00:00.000Z',
        openedAt: '2026-07-27T10:00:12.000Z',
      });
    });

    it('degrades safely when an older API omits the progress timestamps entirely', async () => {
      makeRequestSpy.mockResolvedValue({ authorized: false, status: 'pending' });

      const result = await oxy.pollCommonsSignIn('secret-session-token');

      expect(result.pushSentAt).toBeNull();
      expect(result.openedAt).toBeNull();
      // The pre-existing contract is untouched by the addition.
      expect(result.authorized).toBe(false);
      expect(result.status).toBe('pending');
    });

    it.each([
      ['an explicit null', null],
      ['an empty string', ''],
      ['an unparseable string', 'soon'],
      ['a number (epoch ms, not the ISO contract)', 1700000000000],
      ['an object', { at: '2026-07-27T10:00:00.000Z' }],
      ['a boolean', true],
    ])('drops %s progress timestamp rather than surfacing it', async (_label, value) => {
      makeRequestSpy.mockResolvedValue({
        authorized: false,
        status: 'pending',
        pushSentAt: value,
        openedAt: value,
      });

      const result = await oxy.pollCommonsSignIn('secret-session-token');

      expect(result.pushSentAt).toBeNull();
      expect(result.openedAt).toBeNull();
    });

    it('parses each progress timestamp independently', async () => {
      makeRequestSpy.mockResolvedValue({
        authorized: false,
        status: 'pending',
        pushSentAt: '2026-07-27T10:00:00.000Z',
        openedAt: 'not-a-date',
      });

      const result = await oxy.pollCommonsSignIn('secret-session-token');

      expect(result.pushSentAt).toBe('2026-07-27T10:00:00.000Z');
      expect(result.openedAt).toBeNull();
    });

    it('counts only a literal true as authorized and drops empty identifiers', async () => {
      makeRequestSpy.mockResolvedValue({
        authorized: 'yes',
        sessionId: '',
        publicKey: 42,
        status: 'pending',
      });

      const result = await oxy.pollCommonsSignIn('secret-session-token');

      expect(result).toEqual({
        authorized: false,
        status: 'pending',
        purpose: 'device_sign_in',
        pushSentAt: null,
        openedAt: null,
      });
    });

    it('parses purpose from the status response', async () => {
      makeRequestSpy.mockResolvedValue({
        authorized: false,
        status: 'pending',
        purpose: 'oauth_authorization',
      });

      const result = await oxy.pollCommonsSignIn('secret-session-token');

      expect(result.purpose).toBe('oauth_authorization');
    });

    it.each([
      ['a non-object body', 'pending'],
      ['a null body', null],
    ])('rejects %s rather than returning a half-parsed status', async (_label, value) => {
      makeRequestSpy.mockResolvedValue(value);

      await expect(oxy.pollCommonsSignIn('secret-session-token')).rejects.toThrow(
        /unexpected response shape/,
      );
    });
  });

  describe('deliverCommonsSignIn (relying party)', () => {
    it('POSTs the deliver path WITH a bearer (never skipAuth)', async () => {
      makeRequestSpy.mockResolvedValue({ delivered: true, targets: 2 });

      const result = await oxy.deliverCommonsSignIn('code with/slash');

      expect(result).toEqual({ delivered: true, targets: 2 });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/auth/session/deliver/code%20with%2Fslash',
        undefined,
        { cache: false },
      );
      // Delivery only happens for an identity Oxy already knows from a trusted
      // authenticated context, so the bearer preflight must NOT be skipped.
      expect(makeRequestSpy.mock.calls[0][3]).not.toHaveProperty('skipAuth');
    });

    it('treats zero targets as a normal outcome, not a failure', async () => {
      makeRequestSpy.mockResolvedValue({ delivered: false, targets: 0 });

      const result = await oxy.deliverCommonsSignIn('code-1');

      // No throw, no coercion — the caller routes this to QR.
      expect(result).toEqual({ delivered: false, targets: 0 });
      expect(selectCommonsDelivery({
        platform: 'desktop',
        commonsAvailable: false,
        pushTargets: pushTargetsFromDelivery(result),
      })).toBe('qr');
    });

    it('routes a positive target count to the push wait', async () => {
      makeRequestSpy.mockResolvedValue({ delivered: true, targets: 1 });

      const result = await oxy.deliverCommonsSignIn('code-1');

      expect(selectCommonsDelivery({
        platform: 'desktop',
        commonsAvailable: false,
        pushTargets: pushTargetsFromDelivery(result),
      })).toBe('await-push');
    });

    it('falls back to QR when delivery failed despite eligible targets', async () => {
      makeRequestSpy.mockResolvedValue({ delivered: false, targets: 1 });

      const result = await oxy.deliverCommonsSignIn('code-1');

      expect(result).toEqual({ delivered: false, targets: 1 });
      expect(selectCommonsDelivery({
        platform: 'desktop',
        commonsAvailable: false,
        pushTargets: pushTargetsFromDelivery(result),
      })).toBe('qr');
    });

    it.each([
      ['a non-object body', 'delivered'],
      ['a null body', null],
    ])('rejects %s rather than returning it', async (_label, value) => {
      makeRequestSpy.mockResolvedValue(value);

      await expect(oxy.deliverCommonsSignIn('code-1')).rejects.toThrow(
        /unexpected response shape/,
      );
    });

    it.each([
      ['a missing delivered', { targets: 1 }],
      ['a non-boolean delivered', { delivered: 'true', targets: 1 }],
      ['a missing targets', { delivered: true }],
      ['a non-numeric targets', { delivered: true, targets: '1' }],
      ['a fractional targets', { delivered: true, targets: 1.5 }],
      ['a NaN targets', { delivered: true, targets: Number.NaN }],
      ['a non-finite targets', { delivered: true, targets: Number.POSITIVE_INFINITY }],
      ['a negative targets', { delivered: true, targets: -1 }],
    ])('rejects %s rather than returning a half-parsed result', async (_label, value) => {
      makeRequestSpy.mockResolvedValue(value);

      await expect(oxy.deliverCommonsSignIn('code-1')).rejects.toThrow(
        /incomplete delivery result/,
      );
    });

    it('surfaces a server rejection through the shared error handler', async () => {
      makeRequestSpy.mockRejectedValue(new Error('Invalid or expired sign-in request'));

      await expect(oxy.deliverCommonsSignIn('code-1')).rejects.toThrow(
        'Invalid or expired sign-in request',
      );
    });
  });

  describe('markCommonsApprovalOpened (approver)', () => {
    it('POSTs /auth/session/opened/:authorizeCode with NO bearer', async () => {
      makeRequestSpy.mockResolvedValue(undefined);

      await expect(oxy.markCommonsApprovalOpened('code-1')).resolves.toBeUndefined();

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/auth/session/opened/code-1',
        undefined,
        { cache: false, skipAuth: true },
      );
    });

    it('encodes the public code in the path', async () => {
      makeRequestSpy.mockResolvedValue(undefined);

      await oxy.markCommonsApprovalOpened('code with/slash');

      expect(makeRequestSpy.mock.calls[0][1]).toBe('/auth/session/opened/code%20with%2Fslash');
    });

    it('surfaces a server rejection through the shared error handler', async () => {
      makeRequestSpy.mockRejectedValue(new Error('Sign-in request is not pending'));

      await expect(oxy.markCommonsApprovalOpened('code-1')).rejects.toThrow(
        'Sign-in request is not pending',
      );
    });
  });

  describe('finalizeCommonsOAuth (relying party)', () => {
    it('POSTs the finalize path with the SECRET sessionToken and no bearer', async () => {
      makeRequestSpy.mockResolvedValue({
        code: 'authcode-1',
        redirectUri: 'https://mention.earth',
        expiresIn: 60,
      });

      const result = await oxy.finalizeCommonsOAuth('secret session/token');

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        // The secret token is the credential in the path — encoded, never raw.
        '/auth/session/finalize/secret%20session%2Ftoken',
        undefined,
        expect.objectContaining({ cache: false, skipAuth: true }),
      );
      // An authorization CODE, never a token: the caller still runs the PKCE
      // exchange with the verifier it never sent.
      expect(result).toEqual({
        code: 'authcode-1',
        redirectUri: 'https://mention.earth',
        expiresIn: 60,
      });
    });

    it('does not plant any token (finalization is not a session)', async () => {
      makeRequestSpy.mockResolvedValue({
        code: 'authcode-1',
        redirectUri: 'https://mention.earth',
        expiresIn: 60,
      });

      await oxy.finalizeCommonsOAuth('secret-session-token');

      expect(oxy.getAccessToken()).toBeNull();
    });

    it.each([
      ['a non-object body', 'authcode-1'],
      ['a null body', null],
    ])('rejects %s rather than returning it', async (_label, value) => {
      makeRequestSpy.mockResolvedValue(value);

      await expect(oxy.finalizeCommonsOAuth('secret-session-token')).rejects.toThrow(
        /unexpected response shape/,
      );
    });

    it.each([
      ['a missing code', { redirectUri: 'https://mention.earth', expiresIn: 60 }],
      ['an empty code', { code: '', redirectUri: 'https://mention.earth', expiresIn: 60 }],
      ['a missing redirectUri', { code: 'authcode-1', expiresIn: 60 }],
      ['an empty redirectUri', { code: 'authcode-1', redirectUri: '', expiresIn: 60 }],
      ['a missing expiresIn', { code: 'authcode-1', redirectUri: 'https://mention.earth' }],
      [
        'a non-numeric expiresIn',
        { code: 'authcode-1', redirectUri: 'https://mention.earth', expiresIn: '60' },
      ],
      [
        'a non-finite expiresIn',
        { code: 'authcode-1', redirectUri: 'https://mention.earth', expiresIn: Number.NaN },
      ],
    ])('rejects %s rather than returning a half-parsed result', async (_label, value) => {
      makeRequestSpy.mockResolvedValue(value);

      await expect(oxy.finalizeCommonsOAuth('secret-session-token')).rejects.toThrow(
        /incomplete authorization code/,
      );
    });

    it('surfaces a server rejection through the shared error handler', async () => {
      makeRequestSpy.mockRejectedValue(new Error('Invalid or expired sign-in request'));

      await expect(oxy.finalizeCommonsOAuth('secret-session-token')).rejects.toThrow(
        'Invalid or expired sign-in request',
      );
    });
  });

  describe('getCommonsApprovalInfo (approver)', () => {
    const baseInfo = {
      application: {
        id: 'app1',
        name: 'Mention',
        type: 'first_party' as const,
        isOfficial: true,
        isInternal: false,
        scopes: ['profile'],
      },
      scopes: ['profile'],
      boundOrigin: 'https://mention.earth',
      expiresAt: 1700000300000,
      status: 'pending',
    };

    it('GETs the server-resolved approval info by authorizeCode', async () => {
      makeRequestSpy.mockResolvedValue({ ...baseInfo, originVerified: true });

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result).toEqual({
        ...baseInfo,
        originVerified: true,
        requesterLabel: null,
        purpose: 'device_sign_in',
        subjectAccount: null,
      });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/auth/session/approve-info/code-1',
        undefined,
        expect.objectContaining({ cache: false }),
      );
    });

    it('coerces a missing originVerified to false (fail-safe to "not verified")', async () => {
      makeRequestSpy.mockResolvedValue(baseInfo);

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.originVerified).toBe(false);
    });

    it('parses an OAuth-bound request with its delegated subject account', async () => {
      makeRequestSpy.mockResolvedValue({
        ...baseInfo,
        originVerified: true,
        purpose: 'oauth_authorization',
        subjectAccount: { id: 'acct-org', username: 'oxy', displayName: 'The Oxy Collective' },
      });

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.purpose).toBe('oauth_authorization');
      expect(result.subjectAccount).toEqual({
        id: 'acct-org',
        username: 'oxy',
        displayName: 'The Oxy Collective',
      });
    });

    it('keeps a delegated account without a displayName (omits the key rather than blanking it)', async () => {
      makeRequestSpy.mockResolvedValue({
        ...baseInfo,
        subjectAccount: { id: 'acct-org', username: 'oxy' },
      });

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.subjectAccount).toEqual({ id: 'acct-org', username: 'oxy' });
    });

    it('degrades a server that omits purpose/subjectAccount to a plain device sign-in', async () => {
      makeRequestSpy.mockResolvedValue(baseInfo);

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.purpose).toBe('device_sign_in');
      expect(result.subjectAccount).toBeNull();
    });

    it('coerces an unrecognized purpose to device_sign_in (never implies an OAuth grant)', async () => {
      makeRequestSpy.mockResolvedValue({ ...baseInfo, purpose: 'something_else' });

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.purpose).toBe('device_sign_in');
    });

    it.each([
      ['a half-populated object', { id: 'acct-org' }],
      ['a non-string id', { id: 7, username: 'oxy' }],
      ['an empty username', { id: 'acct-org', username: '' }],
      ['a non-object', 'acct-org'],
      ['an explicit null', null],
    ])('rejects %s subjectAccount whole (fail-safe to "no delegation")', async (_label, value) => {
      makeRequestSpy.mockResolvedValue({ ...baseInfo, subjectAccount: value });

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.subjectAccount).toBeNull();
    });

    it('drops a non-string displayName rather than rendering it', async () => {
      makeRequestSpy.mockResolvedValue({
        ...baseInfo,
        subjectAccount: { id: 'acct-org', username: 'oxy', displayName: 42 },
      });

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.subjectAccount).toEqual({ id: 'acct-org', username: 'oxy' });
    });

    it('coerces a non-boolean originVerified to false', async () => {
      makeRequestSpy.mockResolvedValue({ ...baseInfo, originVerified: 'yes' });

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.originVerified).toBe(false);
    });

    it('passes through a server originVerified:false unchanged', async () => {
      makeRequestSpy.mockResolvedValue({ ...baseInfo, originVerified: false });

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.originVerified).toBe(false);
    });

    it('carries the coarse requester label through verbatim', async () => {
      makeRequestSpy.mockResolvedValue({ ...baseInfo, requesterLabel: 'Chrome on Windows' });

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.requesterLabel).toBe('Chrome on Windows');
    });

    it('trims surrounding whitespace off the label', async () => {
      makeRequestSpy.mockResolvedValue({ ...baseInfo, requesterLabel: '  Safari on iOS  ' });

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.requesterLabel).toBe('Safari on iOS');
    });

    it.each([
      ['omitted (an API that predates the field)', undefined],
      ['an explicit null (native requester)', null],
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['a non-string', 42],
      ['an object', { browser: 'Chrome' }],
    ])('degrades %s requesterLabel to null (the UI omits the line)', async (_label, value) => {
      makeRequestSpy.mockResolvedValue({ ...baseInfo, requesterLabel: value });

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.requesterLabel).toBeNull();
    });

    it('parses BOTH new fields fail-safe when the API omits them entirely', async () => {
      // An older API sends neither `requesterLabel` nor the fields around it —
      // the approval info must still resolve, never throw.
      makeRequestSpy.mockResolvedValue(baseInfo);

      const result = await oxy.getCommonsApprovalInfo('code-1');

      expect(result.requesterLabel).toBeNull();
      expect(result.originVerified).toBe(false);
      expect(result.purpose).toBe('device_sign_in');
      expect(result.subjectAccount).toBeNull();
    });
  });

  describe('approveCommonsSignIn (approver)', () => {
    it('requests a challenge, signs with the PRIMARY key, and POSTs authorize-signed', async () => {
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue('pub-primary');
      const requestChallengeSpy = jest
        .spyOn(oxy, 'requestChallenge')
        .mockResolvedValue(challengeFixture);
      const signChallengeSpy = jest.spyOn(SignatureService, 'signChallenge').mockResolvedValue({
        challenge: 'sig-primary',
        publicKey: 'pub-primary',
        timestamp: 1700000000123,
      });
      // authorize-signed is the only network call (challenge is mocked above).
      makeRequestSpy.mockResolvedValue({ success: true });

      const result = await oxy.approveCommonsSignIn({
        authorizeCode: 'code-1',
        deviceName: 'iPhone',
      });

      expect(requestChallengeSpy).toHaveBeenCalledWith('pub-primary');
      expect(signChallengeSpy).toHaveBeenCalledWith('chal-xyz');
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/auth/session/authorize-signed/code-1',
        {
          publicKey: 'pub-primary',
          challenge: 'chal-xyz',
          signature: 'sig-primary',
          timestamp: 1700000000123,
          deviceName: 'iPhone',
        },
        expect.objectContaining({ cache: false }),
      );
      expect(result).toEqual({ success: true });
    });

    it('omits deviceName/deviceFingerprint when not provided', async () => {
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue('pub-primary');
      jest.spyOn(oxy, 'requestChallenge').mockResolvedValue(challengeFixture);
      jest.spyOn(SignatureService, 'signChallenge').mockResolvedValue({
        challenge: 'sig-primary',
        publicKey: 'pub-primary',
        timestamp: 1700000000123,
      });
      makeRequestSpy.mockResolvedValue({ success: true });

      await oxy.approveCommonsSignIn({ authorizeCode: 'code-1' });

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/auth/session/authorize-signed/code-1',
        {
          publicKey: 'pub-primary',
          challenge: 'chal-xyz',
          signature: 'sig-primary',
          timestamp: 1700000000123,
        },
        expect.objectContaining({ cache: false }),
      );
    });

    it('throws (no network) when the device has no primary identity', async () => {
      jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(null);
      await expect(oxy.approveCommonsSignIn({ authorizeCode: 'code-1' })).rejects.toThrow(
        /No identity found/,
      );
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('denyCommonsSignIn (approver)', () => {
    it('POSTs /auth/session/deny/:authorizeCode', async () => {
      makeRequestSpy.mockResolvedValue({ success: true });

      const result = await oxy.denyCommonsSignIn('code-1');

      expect(result).toEqual({ success: true });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/auth/session/deny/code-1',
        undefined,
        expect.objectContaining({ cache: false }),
      );
    });

    // Iterating the CONTRACT set (rather than a local literal) is the point: the
    // SDK, the API request schema and the persisted `AuthSession.deniedReason`
    // enum all read this one declaration, so a value added on the server side
    // without an SDK release — or the reverse — cannot go unnoticed here.
    it.each([...COMMONS_DENY_REASONS])(
      'sends the closed-set reason %s in the body',
      async (reason) => {
        makeRequestSpy.mockResolvedValue({ success: true });

        const typedReason: CommonsDenyReason = reason;
        await oxy.denyCommonsSignIn('code-1', typedReason);

        expect(makeRequestSpy).toHaveBeenCalledWith(
          'POST',
          '/auth/session/deny/code-1',
          { reason },
          expect.objectContaining({ cache: false }),
        );
      },
    );

    it('sends no body at all when no reason is given (byte-identical to the old call)', async () => {
      makeRequestSpy.mockResolvedValue({ success: true });

      await oxy.denyCommonsSignIn('code-1');

      expect(makeRequestSpy.mock.calls[0][2]).toBeUndefined();
    });
  });

  describe('requestChallenge / verifyChallenge — requestOptions spread into makeRequest', () => {
    it('requestChallenge omits transport overrides by default (retries ON) and spreads them when given', async () => {
      makeRequestSpy.mockResolvedValue(challengeFixture);

      await oxy.requestChallenge('pub-x');
      expect(makeRequestSpy).toHaveBeenLastCalledWith(
        'POST',
        '/auth/challenge',
        { publicKey: 'pub-x' },
        { cache: false, skipAuth: true },
      );

      await oxy.requestChallenge('pub-x', { retry: false });
      expect(makeRequestSpy).toHaveBeenLastCalledWith(
        'POST',
        '/auth/challenge',
        { publicKey: 'pub-x' },
        { cache: false, skipAuth: true, retry: false },
      );
    });

    it('verifyChallenge spreads requestOptions (retry + timeout) into makeRequest', async () => {
      makeRequestSpy.mockResolvedValue(sessionFixture);

      await oxy.verifyChallenge('pub-x', 'chal', 'sig', 123, 'dev', 'fp', {
        retry: false,
        timeout: 9000,
      });

      expect(makeRequestSpy).toHaveBeenLastCalledWith(
        'POST',
        '/auth/verify',
        {
          publicKey: 'pub-x',
          challenge: 'chal',
          signature: 'sig',
          timestamp: 123,
          deviceName: 'dev',
          deviceFingerprint: 'fp',
        },
        { cache: false, skipAuth: true, retry: false, timeout: 9000 },
      );
    });
  });

  describe('signInWithSharedIdentity (Mechanism A — same-device SSO)', () => {
    it('mints a session from the shared key when one exists (native)', async () => {
      jest.spyOn(KeyManager, 'hasSharedIdentity').mockResolvedValue(true);
      jest.spyOn(KeyManager, 'getSharedPublicKey').mockResolvedValue('shared-pub');
      const requestChallengeSpy = jest
        .spyOn(oxy, 'requestChallenge')
        .mockResolvedValue({ challenge: 'chal-shared', expiresAt: '2026-06-26T00:05:00.000Z' });
      jest.spyOn(SignatureService, 'signChallengeWithSharedKey').mockResolvedValue({
        challenge: 'sig-shared',
        publicKey: 'shared-pub',
        timestamp: 1700000000456,
      });
      const verifyChallengeSpy = jest
        .spyOn(oxy, 'verifyChallenge')
        .mockResolvedValue(sessionFixture);

      const result = await oxy.signInWithSharedIdentity({
        deviceName: 'iPad',
        deviceFingerprint: 'fp-1',
      });

      // No requestOptions passed → both round-trips get `undefined` (defaults:
      // retries ON), preserving interactive behaviour.
      expect(requestChallengeSpy).toHaveBeenCalledWith('shared-pub', undefined);
      expect(verifyChallengeSpy).toHaveBeenCalledWith(
        'shared-pub',
        'chal-shared',
        'sig-shared',
        1700000000456,
        'iPad',
        'fp-1',
        undefined,
      );
      expect(result).toEqual(sessionFixture);
    });

    it('threads requestOptions into BOTH the challenge and verify round-trips (cold-boot retry:false)', async () => {
      jest.spyOn(KeyManager, 'hasSharedIdentity').mockResolvedValue(true);
      jest.spyOn(KeyManager, 'getSharedPublicKey').mockResolvedValue('shared-pub');
      const requestChallengeSpy = jest
        .spyOn(oxy, 'requestChallenge')
        .mockResolvedValue({ challenge: 'chal-shared', expiresAt: '2026-06-26T00:05:00.000Z' });
      jest.spyOn(SignatureService, 'signChallengeWithSharedKey').mockResolvedValue({
        challenge: 'sig-shared',
        publicKey: 'shared-pub',
        timestamp: 1700000000456,
      });
      const verifyChallengeSpy = jest
        .spyOn(oxy, 'verifyChallenge')
        .mockResolvedValue(sessionFixture);

      const result = await oxy.signInWithSharedIdentity({
        requestOptions: { retry: false },
      });

      // The SAME requestOptions object is forwarded to both calls — this is how
      // the cold-boot `shared-key-signin` step keeps its two round-trips as
      // single attempts without changing interactive defaults.
      expect(requestChallengeSpy).toHaveBeenCalledWith('shared-pub', { retry: false });
      expect(verifyChallengeSpy).toHaveBeenCalledWith(
        'shared-pub',
        'chal-shared',
        'sig-shared',
        1700000000456,
        undefined,
        undefined,
        { retry: false },
      );
      expect(result).toEqual(sessionFixture);
    });

    it('returns null (no network) when no shared identity exists — the web case', async () => {
      // hasSharedIdentity() is already false on web; emulate that verdict.
      jest.spyOn(KeyManager, 'hasSharedIdentity').mockResolvedValue(false);
      const requestChallengeSpy = jest.spyOn(oxy, 'requestChallenge');
      const verifyChallengeSpy = jest.spyOn(oxy, 'verifyChallenge');

      const result = await oxy.signInWithSharedIdentity();

      expect(result).toBeNull();
      expect(requestChallengeSpy).not.toHaveBeenCalled();
      expect(verifyChallengeSpy).not.toHaveBeenCalled();
    });

    it('returns null when the shared public key is unexpectedly absent', async () => {
      jest.spyOn(KeyManager, 'hasSharedIdentity').mockResolvedValue(true);
      jest.spyOn(KeyManager, 'getSharedPublicKey').mockResolvedValue(null);
      const verifyChallengeSpy = jest.spyOn(oxy, 'verifyChallenge');

      const result = await oxy.signInWithSharedIdentity();

      expect(result).toBeNull();
      expect(verifyChallengeSpy).not.toHaveBeenCalled();
    });
  });

  describe('registerPushToken / unregisterPushToken', () => {
    const expoToken = 'ExponentPushToken[abc123XYZ]';

    it('POSTs the Expo push token with a bearer', async () => {
      makeRequestSpy.mockResolvedValue({ registered: true });

      await expect(
        oxy.registerPushToken({ expoPushToken: expoToken, platform: 'ios' }),
      ).resolves.toBeUndefined();

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/notifications/push-token',
        { token: expoToken, platform: 'ios' },
        { cache: false },
      );
      // Push registration is per-identity — the bearer preflight must run.
      expect(makeRequestSpy.mock.calls[0][3]).not.toHaveProperty('skipAuth');
    });

    it('omits deviceId/clientId entirely when not provided', async () => {
      makeRequestSpy.mockResolvedValue({ registered: true });

      await oxy.registerPushToken({ expoPushToken: expoToken, platform: 'android' });

      // `toHaveBeenCalledWith` ignores explicitly-undefined keys, so assert the
      // literal key set: the server reads PRESENCE of these optional fields.
      expect(Object.keys(makeRequestSpy.mock.calls[0][2])).toEqual(['token', 'platform']);
    });

    it('sends deviceId and clientId when provided', async () => {
      makeRequestSpy.mockResolvedValue({ registered: true });

      await oxy.registerPushToken({
        expoPushToken: expoToken,
        platform: 'ios',
        deviceId: 'dev-1',
        clientId: 'oxy_dk_commons',
      });

      expect(makeRequestSpy.mock.calls[0][2]).toEqual({
        token: expoToken,
        platform: 'ios',
        deviceId: 'dev-1',
        clientId: 'oxy_dk_commons',
      });
    });

    it('accepts the ExpoPushToken spelling as well', async () => {
      makeRequestSpy.mockResolvedValue({ registered: true });

      await oxy.registerPushToken({ expoPushToken: 'ExpoPushToken[abc123]', platform: 'web' });

      expect(makeRequestSpy).toHaveBeenCalled();
    });

    it.each([
      // The exact inbox hazard: getDevicePushTokenAsync's raw FCM/APNs token.
      ['a raw FCM token', 'fMEP0vJqS0y5:APA91bH-longopaquestring'],
      ['a raw APNs hex token', '740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad'],
      ['an empty string', ''],
      ['a truncated wrapper', 'ExponentPushToken['],
      ['an empty wrapper', 'ExponentPushToken[]'],
      ['a token with whitespace inside', 'ExponentPushToken[abc 123]'],
      ['surrounding whitespace', ' ExponentPushToken[abc123] '],
    ])('rejects %s without sending a request', async (_label, token) => {
      await expect(
        oxy.registerPushToken({ expoPushToken: token, platform: 'ios' }),
      ).rejects.toThrow(/Expo push token/);

      expect(makeRequestSpy).not.toHaveBeenCalled();
    });

    it('DELETEs the token on unregister', async () => {
      makeRequestSpy.mockResolvedValue({ unregistered: true });

      await expect(oxy.unregisterPushToken(expoToken)).resolves.toBeUndefined();

      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/notifications/push-token',
        { token: expoToken },
        { cache: false },
      );
    });

    it('surfaces a server rejection through the shared error handler', async () => {
      makeRequestSpy.mockRejectedValue(new Error('Unknown client'));

      await expect(
        oxy.registerPushToken({ expoPushToken: expoToken, platform: 'ios' }),
      ).rejects.toThrow('Unknown client');
    });
  });
});

describe('selectCommonsDelivery — automatic delivery selection', () => {
  const platforms: CommonsDeliveryPlatform[] = ['mobile', 'desktop', 'unknown'];

  it('opens Commons on mobile when a verified Commons link is available', () => {
    expect(
      selectCommonsDelivery({ platform: 'mobile', commonsAvailable: true, pushTargets: 0 }),
    ).toBe('open-commons');
  });

  it('prefers opening Commons over a push that also has targets', () => {
    // Rule 1 wins outright — the identity is already reachable on this device,
    // so nobody's other phone should ring.
    expect(
      selectCommonsDelivery({ platform: 'mobile', commonsAvailable: true, pushTargets: 3 }),
    ).toBe('open-commons');
  });

  it('awaits the push on mobile without a verified Commons link', () => {
    expect(
      selectCommonsDelivery({ platform: 'mobile', commonsAvailable: false, pushTargets: 1 }),
    ).toBe('await-push');
  });

  it('awaits the push on a desktop with a known Commons installation', () => {
    expect(
      selectCommonsDelivery({ platform: 'desktop', commonsAvailable: false, pushTargets: 2 }),
    ).toBe('await-push');
  });

  it('shows the QR on an unknown desktop browser', () => {
    expect(
      selectCommonsDelivery({ platform: 'desktop', commonsAvailable: false, pushTargets: 0 }),
    ).toBe('qr');
  });

  it('never deep-links from desktop even when a Commons link is claimed available', () => {
    // A custom-scheme navigation that does not resolve is a dead end, so a
    // desktop caller falls through to push/QR regardless.
    expect(
      selectCommonsDelivery({ platform: 'desktop', commonsAvailable: true, pushTargets: 0 }),
    ).toBe('qr');
    expect(
      selectCommonsDelivery({ platform: 'desktop', commonsAvailable: true, pushTargets: 1 }),
    ).toBe('await-push');
  });

  it('never deep-links from an unknown platform (degrades to push, then QR)', () => {
    expect(
      selectCommonsDelivery({ platform: 'unknown', commonsAvailable: true, pushTargets: 0 }),
    ).toBe('qr');
    expect(
      selectCommonsDelivery({ platform: 'unknown', commonsAvailable: true, pushTargets: 1 }),
    ).toBe('await-push');
    expect(
      selectCommonsDelivery({ platform: 'unknown', commonsAvailable: false, pushTargets: 0 }),
    ).toBe('qr');
  });

  it('treats zero targets as QR on every platform (a normal outcome, not an error)', () => {
    for (const platform of platforms) {
      expect(selectCommonsDelivery({ platform, commonsAvailable: false, pushTargets: 0 })).toBe(
        'qr',
      );
    }
  });

  it.each([
    ['a negative count', -1],
    ['a fractional count', 0.5],
    ['a fractional count above one', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('degrades %s to QR rather than a push nobody will answer', (_label, pushTargets) => {
    expect(selectCommonsDelivery({ platform: 'desktop', commonsAvailable: false, pushTargets })).toBe(
      'qr',
    );
  });

  it('is pure — the same facts always yield the same route', () => {
    const facts = {
      platform: 'desktop' as const,
      commonsAvailable: false,
      pushTargets: 1,
    };

    expect(selectCommonsDelivery(facts)).toBe('await-push');
    expect(selectCommonsDelivery(facts)).toBe('await-push');
    // ...and it does not mutate the caller's facts.
    expect(facts).toEqual({ platform: 'desktop', commonsAvailable: false, pushTargets: 1 });
  });

  it('covers every (platform × commonsAvailable × targets) combination with one route', () => {
    const routes = new Set<string>();
    for (const platform of platforms) {
      for (const commonsAvailable of [true, false]) {
        for (const pushTargets of [0, 1]) {
          routes.add(selectCommonsDelivery({ platform, commonsAvailable, pushTargets }));
        }
      }
    }
    // Exactly the three primary routes — no chained/compound outcome exists.
    expect([...routes].sort()).toEqual(['await-push', 'open-commons', 'qr']);
  });
});
