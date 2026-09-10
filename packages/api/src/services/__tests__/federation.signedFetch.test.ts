/**
 * Federation signed-fetch signing-string contract.
 *
 * Locks oxy-api's outbound signed GETs to the same draft-cavage signing string
 * as @oxy.so/federation (incl. query strings on the request-target line).
 */

import crypto from 'crypto';
import { signRequest } from '@oxy.so/federation';

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

const KEY_ID = 'https://mastodon.social/users/alice#main-key';
const GET_URL = 'https://remote.example/users/bob/outbox?page=true';
const FIXED_DATE_HEADER = 'Thu, 16 Jul 2026 12:00:00 GMT';

describe('federation signed GET signing string', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-07-16T12:00:00.000Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('includes the query string on the (request-target) line', async () => {
    const sign = async (_keyId: string, signingString: string): Promise<string> => {
      expect(signingString).toBe(
        `(request-target): get /users/bob/outbox?page=true\nhost: remote.example\ndate: ${FIXED_DATE_HEADER}`,
      );
      const signer = crypto.createSign('sha256');
      signer.update(signingString);
      signer.end();
      return signer.sign(TEST_PRIVATE_KEY_PEM, 'base64');
    };

    const headers = await signRequest(sign, KEY_ID, 'GET', GET_URL);
    expect(headers.Host).toBe('remote.example');
    expect(headers.Date).toBe(FIXED_DATE_HEADER);
    expect(headers.Signature).toContain('headers="(request-target) host date"');
  });
});
