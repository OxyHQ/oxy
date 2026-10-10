/**
 * Scoped media token (`utils/mediaToken.ts`) — the `?mt=` credential minted for
 * private-asset stream URLs.
 *
 * Verifies the security envelope of the token directly against the crypto:
 *  - a fresh token verifies for the asset + viewer it was minted for,
 *  - it does NOT verify for a DIFFERENT asset (single-asset binding),
 *  - it expires (short TTL is the revocation story),
 *  - an access/service-token-shaped JWT signed with ACCESS_TOKEN_SECRET does NOT
 *    verify as a media token (disjoint key families), and vice-versa a media
 *    token does not verify under ACCESS_TOKEN_SECRET,
 *  - a rotated ACCESS_TOKEN_SECRET rotates the media key (old tokens die),
 *  - minting throws when ACCESS_TOKEN_SECRET is absent.
 */

process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';

// The global jest.setup.cjs stubs `jsonwebtoken`. This suite exercises the real
// HS256 sign/verify, so restore the genuine module.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

import jwt from 'jsonwebtoken';
import {
  signMediaToken,
  verifyMediaToken,
  MediaTokenNotConfiguredError,
  MEDIA_TOKEN_TTL_SECONDS,
  MEDIA_TOKEN_QUERY_PARAM,
} from '../mediaToken';

const SECRET = 'test-access-token-secret';
const FILE_A = '64c0000000000000000000a1';
const FILE_B = '64c0000000000000000000b2';
const VIEWER = '69b2d3df5d12f58c9800d651';

beforeEach(() => {
  process.env.ACCESS_TOKEN_SECRET = SECRET;
});

describe('signMediaToken / verifyMediaToken', () => {
  it('verifies for the asset + viewer it was minted for', () => {
    const token = signMediaToken(FILE_A, VIEWER);
    expect(verifyMediaToken(token, FILE_A)).toBe(VIEWER);
  });

  it('does NOT verify for a different asset id (single-asset binding)', () => {
    const token = signMediaToken(FILE_A, VIEWER);
    expect(verifyMediaToken(token, FILE_B)).toBeUndefined();
  });

  it('carries a short TTL and expires', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const token = signMediaToken(FILE_A, VIEWER);
      // Just before expiry → still valid.
      jest.setSystemTime(
        new Date(Date.parse('2026-01-01T00:00:00Z') + (MEDIA_TOKEN_TTL_SECONDS - 5) * 1000),
      );
      expect(verifyMediaToken(token, FILE_A)).toBe(VIEWER);
      // Past expiry → rejected.
      jest.setSystemTime(
        new Date(Date.parse('2026-01-01T00:00:00Z') + (MEDIA_TOKEN_TTL_SECONDS + 5) * 1000),
      );
      expect(verifyMediaToken(token, FILE_A)).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects garbage and empty strings', () => {
    expect(verifyMediaToken('not-a-jwt', FILE_A)).toBeUndefined();
    expect(verifyMediaToken('', FILE_A)).toBeUndefined();
  });

  it('rejects an access-token-shaped JWT signed with ACCESS_TOKEN_SECRET', () => {
    // A real session/access token must never double as a media credential.
    const accessLike = jwt.sign({ type: 'access', sessionId: 's1', userId: VIEWER }, SECRET, {
      expiresIn: 3600,
    });
    expect(verifyMediaToken(accessLike, FILE_A)).toBeUndefined();
  });

  it('mints a token that does NOT verify under ACCESS_TOKEN_SECRET (disjoint key families)', () => {
    const token = signMediaToken(FILE_A, VIEWER);
    // The access/service verifier uses ACCESS_TOKEN_SECRET directly; a media
    // token must fail that verification so it cannot authenticate other surfaces.
    expect(() => jwt.verify(token, SECRET)).toThrow();
  });

  it('rotates the media key when ACCESS_TOKEN_SECRET rotates (old tokens die)', () => {
    const token = signMediaToken(FILE_A, VIEWER);
    expect(verifyMediaToken(token, FILE_A)).toBe(VIEWER);
    process.env.ACCESS_TOKEN_SECRET = 'rotated-secret-value-000000000000';
    expect(verifyMediaToken(token, FILE_A)).toBeUndefined();
  });

  it('throws MediaTokenNotConfiguredError when ACCESS_TOKEN_SECRET is unset', () => {
    delete process.env.ACCESS_TOKEN_SECRET;
    expect(() => signMediaToken(FILE_A, VIEWER)).toThrow(MediaTokenNotConfiguredError);
  });

  it('verify returns undefined (never throws) when ACCESS_TOKEN_SECRET is unset', () => {
    const token = signMediaToken(FILE_A, VIEWER);
    delete process.env.ACCESS_TOKEN_SECRET;
    expect(verifyMediaToken(token, FILE_A)).toBeUndefined();
  });

  it('exposes the query-param name used on stream URLs', () => {
    expect(MEDIA_TOKEN_QUERY_PARAM).toBe('mt');
  });
});
