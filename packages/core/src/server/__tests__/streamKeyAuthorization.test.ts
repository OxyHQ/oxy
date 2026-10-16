/**
 * `verifyStreamKeyAuthorization` (ADR 0042 stage 4c): the synchronous request
 * Oxy sends a file-events endpoint before it serves a play session's key,
 * signed exactly like a file event.
 */
import { createHmac } from 'node:crypto';
import {
  STREAM_KEY_AUTHORIZATION_EVENT_TYPE,
  StreamKeyAuthorizationVerificationError,
  verifyStreamKeyAuthorization,
  verifyFileEventSignature,
  FileEventVerificationError,
} from '../index';

const secret = 'whsec_test_secret';
const now = new Date('2026-10-16T12:00:00.000Z');
const t = Math.floor(now.getTime() / 1000);

const request = {
  id: 'kar_1',
  type: STREAM_KEY_AUTHORIZATION_EVENT_TYPE,
  occurredAt: now.toISOString(),
  session: {
    id: 'ps_1',
    fileId: 'file-1',
    endUserId: 'user-1',
    expiresAt: '2026-10-16T13:00:00.000Z',
  },
};

function sign(body: string, timestamp = t, key = secret): string {
  return `t=${timestamp},v1=${createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')}`;
}

describe('verifyStreamKeyAuthorization', () => {
  const body = JSON.stringify(request);

  it('returns the request for a valid signature (Node headers or fetch Headers, string or bytes)', () => {
    expect(
      verifyStreamKeyAuthorization(body, { 'oxy-signature': sign(body) }, secret, { now }),
    ).toEqual(request);
    expect(
      verifyStreamKeyAuthorization(
        new TextEncoder().encode(body),
        new Headers({ 'Oxy-Signature': sign(body) }),
        secret,
        { now },
      ),
    ).toEqual(request);
  });

  it('accepts an anonymous session (endUserId null)', () => {
    const anonymous = JSON.stringify({
      ...request,
      session: { ...request.session, endUserId: null },
    });
    expect(
      verifyStreamKeyAuthorization(anonymous, { 'oxy-signature': sign(anonymous) }, secret, { now })
        .session.endUserId,
    ).toBeNull();
  });

  it('refuses a tampered body, a wrong secret, a missing or malformed header', () => {
    const tampered = body.replace('user-1', 'user-2');
    const cases: Array<[string, Record<string, string>, string]> = [
      [tampered, { 'oxy-signature': sign(body) }, secret],
      [body, { 'oxy-signature': sign(body, t, 'whsec_other') }, secret],
      [body, {}, secret],
      [body, { 'oxy-signature': 'v1=abc' }, secret],
      [body, { 'oxy-signature': sign(body) }, ''],
    ];
    for (const [raw, headers, key] of cases) {
      expect(() => verifyStreamKeyAuthorization(raw, headers, key, { now })).toThrow(
        StreamKeyAuthorizationVerificationError,
      );
    }
  });

  it('refuses a timestamp outside the replay window, and honours a custom tolerance', () => {
    const old = sign(body, t - 301);
    expect(() =>
      verifyStreamKeyAuthorization(body, { 'oxy-signature': old }, secret, { now }),
    ).toThrow(/replay window/);
    expect(
      verifyStreamKeyAuthorization(body, { 'oxy-signature': old }, secret, {
        now,
        toleranceSeconds: 600,
      }).id,
    ).toBe('kar_1');
    expect(() =>
      verifyStreamKeyAuthorization(body, { 'oxy-signature': sign(body, t - 31) }, secret, {
        now,
        toleranceSeconds: 30,
      }),
    ).toThrow(/replay window/);
  });

  it('refuses a correctly signed body that is not a key authorization request', () => {
    for (const other of [
      { ...request, type: 'file.deleted' },
      { ...request, session: { ...request.session, fileId: 7 } },
      { type: 'webhook.challenge', challenge: 'x' },
      [request],
    ]) {
      const raw = JSON.stringify(other);
      expect(() =>
        verifyStreamKeyAuthorization(raw, { 'oxy-signature': sign(raw) }, secret, { now }),
      ).toThrow(/not a key authorization request/);
    }
  });

  it('is not a file event: verifyFileEventSignature refuses it', () => {
    expect(() =>
      verifyFileEventSignature(body, { 'oxy-signature': sign(body) }, secret, { now }),
    ).toThrow(FileEventVerificationError);
  });
});
