import crypto from 'node:crypto';
import {
  signRequest,
  verifyHttpSignature,
  HTTP_SIGNATURE_ALGORITHM,
  DEFAULT_SIGNED_CONTENT_TYPE,
  type HttpSignatureSigner,
} from '../index';

/**
 * GOLDEN HTTP-signature vector (byte-frozen).
 *
 * These literals were produced by Mention's ORIGINAL `crypto.ts` `signRequest`
 * (draft-cavage-http-signatures-12) for a FIXED RSA key + a FIXED clock, then
 * asserted byte-identical against this engine's `signRequest`. A change to the
 * covered-header list, its order, the signing-string bytes, the signature
 * params, or the digest would break this test — which is the point: a drift here
 * silently kills ALL federation, so it is locked to the exact bytes remote
 * servers (Mastodon et al.) verify against.
 *
 * The signature bytes are deterministic because RSASSA-PKCS1-v1_5 over a fixed
 * signing string + fixed key is deterministic, so the golden is reproducible.
 */

// A fixed, throwaway RSA-2048 test key (never used anywhere else).
const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCiZQEzhw+dKDGE
q7hhpcxsdRacYcJMWDFgMCdQO+VNCcRKJmtyjkQVb/HdiAn06cdDTHlM6blcRNtJ
Mbo5QKE1LxNH7BwhmfJ6cGdjNfUW2fh9oL5I+yEAKWRvaMsN/3JQLd2hkuBshz2/
FKRozgNlGvp5FZxmnHcoSYIDzDvoD16IpJsKfL7mgipy+JayIewJedvsiCTjzz9T
QCsjuODmiB2+NZhKyI0i0vgC2ggt9Mb8VgfPgCtlG9BN2exVhRCSH4TagNviW3Uv
ZpdcLB+M2cycjtqtYiJGCEXZaRMkiqm9AAMuXktiBBNjCsPNtv6WGbmmaarNPe5y
7aN+zf6TAgMBAAECggEAATrYmSZNtPf9Sq7uP4xnkZlgFCEdZ+ycZckXkyD7qetd
WYkUST17QIT6L55RzPwJmUs2o/bP2OYLRHD5oxNdOoTiatSxRdk09T5tWgVU7NkL
wQ/QQRyTHGgz2DAn/DF8u89icqXPyKKhkhU68DGXOah2+yccackyPH40sN4Bb3l4
kIc1G6guSW54B0rPau73ngSZjc8lR5b6L37FIKV3aEw8+jFHxoCVxUJbaQ1wYf/l
FzHFM9y1ktdeuWTYj+idHyp8yn3P5H/sD3ynSyz8LNVe9+Ny/2CdNbBQfQFoM9Wq
WpNUQJtU7hLX4ccf02eKNwVx5tMQOMWbCNEEx4Zj8QKBgQDWYMyTmj8faWCFB0nq
nZUhNO5Dd4doimFbbowbUNbfEX1NSvO3FHm9PqRWdoe1ib13lrqjdEM/Co+jUGu+
6h24H5DATr/Ky1vgeSVo6eiAY8/m/X4J9cDklXTCNbbolvqmFoMzRn9tSnuCs4Fh
UVW04E9flX5xzEAziL6jjRSeiQKBgQDB7Hl8E0A7HHZXUR3jDq2EsQQqYmrw7Hd2
TcYjCWvdgVMNxzJsPdvS5PnZCpgSoVJtnC4DaC2RoslDHlF8+gNEnhXAxj4IKSV1
udc3IXyFSvh2bCG5FKvFAyzIPtQZwFlqgrffPYh0fcZ7Y+Klx9bpJCvf28+wwBdy
fM9x0tyNOwKBgQCDVa4/RyIgxlghZ4O7Pmtceqb1okbMnupiL2maWn4pDvfq4F5K
7Tpf2/6mEdu2NfpjR250MQf5mSjCbsRzo84tPPlbN2N8g/V3ogBvM84CyiNWajpL
M8nGwGFVkb7K46QPGH+sbCYo+JaOThaXXlLZiwpVjqp2YSF78OyKGiZlsQKBgHyw
a1CfJC6d122/Z4MmXeWy2CXUkESHFy0HRv4iQav0So3SZhZ5E84fkpK+oBdiiRiX
UnK4WoyI6fXxGZ5NNyq4pu4DycD/i+mNa9cz/dfK48VpM6nIo8WSjAnZdBF2v0ef
81BkRUf501RlXkcQHpxbuKZAtONGMA1aORxL46ofAoGBAMGixHxEm/kR2IDojwSz
Fy+kNal2NcJ+FNXtWuDpxsZ/ZPbcFZo4oBinMuXYhBZW42XfmzVF7rXECiO0Hqk8
uAxjXwx8G/LX9Gcuox4VfCuykAZkDL24HnVQVakSJJtJHNMlyY4rjnW85DL32jaI
yErcwyo5HiEb9dAKGiHgaHuQ
-----END PRIVATE KEY-----
`;

const TEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAomUBM4cPnSgxhKu4YaXM
bHUWnGHCTFgxYDAnUDvlTQnESiZrco5EFW/x3YgJ9OnHQ0x5TOm5XETbSTG6OUCh
NS8TR+wcIZnyenBnYzX1Ftn4faC+SPshAClkb2jLDf9yUC3doZLgbIc9vxSkaM4D
ZRr6eRWcZpx3KEmCA8w76A9eiKSbCny+5oIqcviWsiHsCXnb7Igk488/U0ArI7jg
5ogdvjWYSsiNItL4AtoILfTG/FYHz4ArZRvQTdnsVYUQkh+E2oDb4lt1L2aXXCwf
jNnMnI7arWIiRghF2WkTJIqpvQADLl5LYgQTYwrDzbb+lhm5pmmqzT3ucu2jfs3+
kwIDAQAB
-----END PUBLIC KEY-----
`;

const ACTOR_URI = 'https://mastodon.social/users/alice';
const KEY_ID = `${ACTOR_URI}#main-key`;
const INBOX_URL = 'https://mention.earth/ap/inbox';
const GET_URL = 'https://remote.example/users/bob/outbox?page=true';

// The exact instant the golden vector was frozen at.
const FIXED_MS = Date.parse('2026-07-16T12:00:00.000Z');
const FIXED_DATE_HEADER = 'Thu, 16 Jul 2026 12:00:00 GMT';

// --- The frozen golden bytes (see file header). ---
const GOLDEN = {
  getSigningString: `(request-target): get /users/bob/outbox?page=true
host: remote.example
date: ${FIXED_DATE_HEADER}`,
  getSignature:
    'keyId="https://mastodon.social/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="IzEGSjHBzcHzBRJOyiVkuVecnix0Q5PzPcULn+VJlRQTozf2Wyks6vmrhEmn5fH7SiyslV1BuUwak5ZKlnh4X33SvmaRU87+X1sJi/OoBrlYXJDaHdf7gTZ2XxOYGzGyCC45BSopH+QQmu+05nUts3kO7FE7U7tm0u+DQZ7bWBPAf1sfgtZwcnEIWGyj5GHVmLIXn7H3oydq+CePAh/ZS6D2+WwUdi07hwkOki6Z2F21IQd/Q6kHiWa7xa7PtLpzPgzfDGCBlPUZ7Txh/zh647dVAX0HAVzGZ6G+SNC+Y9EAt+CrUJKun7iFmnhWhogxX10m48p5l6kKmAufbjb0Kg=="',
  postBody:
    '{"@context":"https://www.w3.org/ns/activitystreams","type":"Create","id":"https://mention.earth/ap/users/alice/activities/1","actor":"https://mention.earth/ap/users/alice"}',
  postDigest: 'SHA-256=oRgduk5xFPsdFoqJgp46OSzBnw4QjKP2vAdqvqtbYkA=',
  postSigningString: `(request-target): post /ap/inbox
host: mention.earth
date: ${FIXED_DATE_HEADER}
digest: SHA-256=oRgduk5xFPsdFoqJgp46OSzBnw4QjKP2vAdqvqtbYkA=
content-type: application/activity+json`,
  postSignature:
    'keyId="https://mastodon.social/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest content-type",signature="gn8c6OJ1JcIHm5LIFOcUCbPQIepblvF11sHRmZ/y/UvrXxNUxemLzI/rp1mpI4MR8V/4F65EWX0XTklC1jkQY1QgzQqXaC9absLmSdm6ys5MBt/rP+FoCVkLx6wAutjW3LFnaEmn5r9vT3cTuGHZeSFHbwMs27bxFsLf/8xwXre/qUVTCc0TE1EsnUQYyGFfL0EeRydYlgCE9T19RO13mkYcvNpS2rXS8AeQ7/7zjCNsbHhPJjWQ+g2z91yVUrMJB5m8VhKo/nGDruuTDRhUArEg3xuue5VffoikSxifNN5mQx7bcyAMjZBxcCgLUeAnEA71Y00nA5r6pgKPeFzKlA=="',
} as const;

// Deterministic RSA-SHA256 signer with the fixed key (mirrors oxy-api /federation/sign).
const sign: HttpSignatureSigner = async (_keyId, signingString) => {
  const s = crypto.createSign('sha256');
  s.update(signingString);
  s.end();
  return s.sign(TEST_PRIVATE_KEY_PEM, 'base64');
};

/** A signer that ALSO captures the exact signing string it received. */
function capturingSigner(): { fn: HttpSignatureSigner; signingString: () => string } {
  let captured = '';
  return {
    fn: async (keyId, signingString) => {
      captured = signingString;
      return sign(keyId, signingString);
    },
    signingString: () => captured,
  };
}

const fetchPublicKey = async (keyId: string) =>
  keyId === KEY_ID ? { publicKeyPem: TEST_PUBLIC_KEY_PEM, actorUri: ACTOR_URI } : null;

/** Reproduce how Express lowercases req.headers, folding content-type as a real header. */
function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const lowered = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (lowered.digest && !lowered['content-type']) {
    lowered['content-type'] = DEFAULT_SIGNED_CONTENT_TYPE;
  }
  return lowered;
}

// Freeze the wall clock so `new Date().toUTCString()` and the ±10min verify skew
// are deterministic (both OLD and NEW read `new Date()` at call time).
const RealDate = Date;
beforeAll(() => {
  class FixedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) {
        super(FIXED_MS);
      } else {
        super(...args);
      }
    }
    static now(): number {
      return FIXED_MS;
    }
  }
  (globalThis as { Date: typeof Date }).Date = FixedDate as unknown as typeof Date;
});
afterAll(() => {
  (globalThis as { Date: typeof Date }).Date = RealDate;
});

describe('signRequest — golden byte vector', () => {
  it('uses the frozen algorithm parameter and default signed content type', () => {
    expect(HTTP_SIGNATURE_ALGORITHM).toBe('rsa-sha256');
    expect(DEFAULT_SIGNED_CONTENT_TYPE).toBe('application/activity+json');
  });

  it('produces the byte-identical Signature + signing string for a GET (no body)', async () => {
    const cap = capturingSigner();
    const headers = await signRequest(cap.fn, KEY_ID, 'GET', GET_URL);

    expect(cap.signingString()).toBe(GOLDEN.getSigningString);
    expect(headers.Signature).toBe(GOLDEN.getSignature);
    expect(headers.Host).toBe('remote.example');
    expect(headers.Date).toBe(FIXED_DATE_HEADER);
    // A GET carries no body → no Digest, and content-type is NOT signed.
    expect(headers.Digest).toBeUndefined();
    expect(cap.signingString()).not.toContain('digest:');
    expect(cap.signingString()).not.toContain('content-type:');
  });

  it('produces the byte-identical Signature + digest + signing string for a POST (with body)', async () => {
    const cap = capturingSigner();
    const headers = await signRequest(cap.fn, KEY_ID, 'POST', INBOX_URL, GOLDEN.postBody);

    expect(headers.Digest).toBe(GOLDEN.postDigest);
    expect(cap.signingString()).toBe(GOLDEN.postSigningString);
    expect(headers.Signature).toBe(GOLDEN.postSignature);
    expect(headers.Host).toBe('mention.earth');
    expect(headers.Date).toBe(FIXED_DATE_HEADER);
    // The covered-header list order is load-bearing.
    expect(headers.Signature).toContain('headers="(request-target) host date digest content-type"');
  });

  it('honours a caller-supplied content type in the signed string', async () => {
    const cap = capturingSigner();
    await signRequest(cap.fn, KEY_ID, 'POST', INBOX_URL, GOLDEN.postBody, {
      contentType: 'application/ld+json',
    });
    expect(cap.signingString()).toContain('content-type: application/ld+json');
  });
});

describe('verifyHttpSignature', () => {
  it('verifies a signature produced by signRequest and returns the actor URI', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = await signRequest(sign, KEY_ID, 'POST', INBOX_URL, body);

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers: lowerHeaders(signed), body },
      fetchPublicKey,
    );

    expect(result.verified).toBe(true);
    expect(result.actorUri).toBe(ACTOR_URI);
  });

  it('rejects when the Signature header is missing', async () => {
    const result = await verifyHttpSignature(
      { method: 'POST', path: '/ap/inbox', headers: {}, body: '' },
      fetchPublicKey,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('missing-signature');
  });

  it('rejects when the public key cannot be fetched', async () => {
    const body = JSON.stringify({ type: 'Create' });
    const signed = await signRequest(sign, 'https://other/key#main', 'POST', INBOX_URL, body);
    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers: lowerHeaders(signed), body },
      fetchPublicKey,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('key-fetch-failed');
  });

  it('rejects when the body is tampered after signing (digest mismatch)', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = await signRequest(sign, KEY_ID, 'POST', INBOX_URL, body);
    const result = await verifyHttpSignature(
      {
        method: 'POST',
        path: new URL(INBOX_URL).pathname,
        headers: lowerHeaders(signed),
        body: JSON.stringify({ type: 'Create', id: 'https://remote/a/TAMPERED' }),
      },
      fetchPublicKey,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('digest-mismatch');
  });

  it('rejects when the signed string does not match (verify-failed)', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = await signRequest(sign, KEY_ID, 'POST', INBOX_URL, body);
    const result = await verifyHttpSignature(
      { method: 'POST', path: '/ap/different-inbox', headers: lowerHeaders(signed), body },
      fetchPublicKey,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('verify-failed');
  });

  it('rejects when the Date header is outside the allowed skew', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = await signRequest(sign, KEY_ID, 'POST', INBOX_URL, body);
    const stale = lowerHeaders(signed);
    stale.date = new Date(Date.now() - 30 * 60 * 1000).toUTCString(); // 30 min ago
    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers: stale, body },
      fetchPublicKey,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('date-skew');
  });
});

describe('verifyHttpSignature — X-Forwarded-Host (trustForwardedHost)', () => {
  const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });

  it('verifies via the origin host when X-Forwarded-Host carries the signed apex (trust=true)', async () => {
    const signed = await signRequest(sign, KEY_ID, 'POST', INBOX_URL, body);
    const headers = lowerHeaders(signed);
    headers.host = 'api.mention.earth';
    headers['x-forwarded-host'] = 'mention.earth';

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers, body },
      fetchPublicKey,
      { trustForwardedHost: true },
    );
    expect(result.verified).toBe(true);
    expect(result.actorUri).toBe(ACTOR_URI);
  });

  it('uses only the first token of a comma-separated X-Forwarded-Host list (trust=true)', async () => {
    const signed = await signRequest(sign, KEY_ID, 'POST', INBOX_URL, body);
    const headers = lowerHeaders(signed);
    headers.host = 'api.mention.earth';
    headers['x-forwarded-host'] = 'mention.earth, proxy-a.internal, proxy-b.internal';

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers, body },
      fetchPublicKey,
      { trustForwardedHost: true },
    );
    expect(result.verified).toBe(true);
  });

  it('falls back to the Host header when X-Forwarded-Host is absent (trust=true, direct delivery)', async () => {
    const signed = await signRequest(sign, KEY_ID, 'POST', INBOX_URL, body);
    const headers = lowerHeaders(signed);
    expect(headers['x-forwarded-host']).toBeUndefined();

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers, body },
      fetchPublicKey,
      { trustForwardedHost: true },
    );
    expect(result.verified).toBe(true);
  });

  it('fails when X-Forwarded-Host does not match the signed host (cryptographic host binding)', async () => {
    const signed = await signRequest(sign, KEY_ID, 'POST', INBOX_URL, body);
    const headers = lowerHeaders(signed);
    headers.host = 'api.mention.earth';
    headers['x-forwarded-host'] = 'evil.example';

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers, body },
      fetchPublicKey,
      { trustForwardedHost: true },
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('verify-failed');
  });

  it('ignores X-Forwarded-Host when trust is off — a rewritten origin Host fails to verify', async () => {
    const signed = await signRequest(sign, KEY_ID, 'POST', INBOX_URL, body);
    const headers = lowerHeaders(signed);
    // Edge rewrote the origin Host; the signed host was mention.earth.
    headers.host = 'api.mention.earth';
    headers['x-forwarded-host'] = 'mention.earth';

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers, body },
      fetchPublicKey,
      { trustForwardedHost: false },
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('verify-failed');
  });
});
