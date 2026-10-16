/**
 * `verifyFileEventSignature` (ADR 0043 D9): what a receiver of Oxy's file
 * events accepts. The signature is HMAC-SHA256 over `<t>.<raw body>`; a wrong
 * secret, a changed byte, a stale or future timestamp, a missing or malformed
 * header and a body that is not a file event are all refused. The endpoint
 * challenge is handed back to be echoed.
 */
import { createHmac } from 'node:crypto';
import { FileEventVerificationError, verifyFileEventSignature } from '../fileEvents';

const SECRET = 'whsec_test';
const event = {
  id: '0190e0f0-0000-7000-8000-000000000001',
  type: 'file.deleted',
  occurredAt: '2026-10-16T10:00:00.000Z',
  file: { id: 'f1', ownerKind: 'application', visibility: 'public', status: 'deleted' },
  references: [{ entityType: 'listing', entityId: 'l1' }],
};
const body = JSON.stringify(event);
const NOW = new Date('2026-10-16T10:00:30.000Z');
const T = Math.floor(NOW.getTime() / 1000);

function sign(text: string, t = T, secret = SECRET): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${text}`).digest('hex')}`;
}

describe('verifyFileEventSignature', () => {
  it('accepts a signed event from a string, bytes, a header object or Headers', () => {
    const header = sign(body);
    expect(
      verifyFileEventSignature(body, { 'oxy-signature': header }, SECRET, { now: NOW }),
    ).toEqual(event);
    expect(
      verifyFileEventSignature(Buffer.from(body), { 'Oxy-Signature': header }, SECRET, {
        now: NOW,
      }),
    ).toEqual(event);
    expect(
      verifyFileEventSignature(
        new TextEncoder().encode(body),
        new Headers({ 'oxy-signature': header }),
        SECRET,
        { now: NOW },
      ),
    ).toEqual(event);
    // Several v1 values (a rotation window): one matching is enough.
    expect(
      verifyFileEventSignature(
        body,
        { 'oxy-signature': `${sign(body, T, 'whsec_old')},v1=${sign(body).split('v1=')[1]}` },
        SECRET,
        { now: NOW },
      ),
    ).toEqual(event);
  });

  it.each([
    ['a wrong secret', body, sign(body, T, 'whsec_other')],
    ['a changed body', body.replace('l1', 'l2'), sign(body)],
    ['a stale timestamp', body, sign(body, T - 301)],
    ['a future timestamp', body, sign(body, T + 301)],
    ['no signature', body, undefined],
    ['a malformed header', body, 'v1=abc'],
  ])('refuses %s', (_label, text, header) => {
    expect(() =>
      verifyFileEventSignature(
        text,
        header === undefined ? {} : { 'oxy-signature': header },
        SECRET,
        { now: NOW },
      ),
    ).toThrow(FileEventVerificationError);
  });

  it('honours a wider replay window when asked', () => {
    expect(
      verifyFileEventSignature(body, { 'oxy-signature': sign(body, T - 600) }, SECRET, {
        now: NOW,
        toleranceSeconds: 900,
      }),
    ).toEqual(event);
  });

  it('refuses a signed body that is not a file event', () => {
    const other = JSON.stringify({
      id: 'x',
      type: 'account.deleted',
      file: { id: 'f' },
      references: [],
    });
    expect(() =>
      verifyFileEventSignature(other, { 'oxy-signature': sign(other) }, SECRET, { now: NOW }),
    ).toThrow('not a file event');
  });

  it('hands back the endpoint challenge to echo, without a signature', () => {
    const challenge = JSON.stringify({ type: 'webhook.challenge', challenge: 'abc' });
    expect(verifyFileEventSignature(challenge, {}, '')).toEqual({
      type: 'webhook.challenge',
      challenge: 'abc',
    });
  });
});
