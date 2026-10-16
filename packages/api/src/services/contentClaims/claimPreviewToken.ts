/**
 * The credential a reviewer previews a claimed file with (ADR 0041 D10).
 *
 * A claimed file is usually not servable — blocked, trashed, private, deleted
 * with its bytes held as evidence — and an `<img>` / `<video>` in the console
 * can send no bearer. So `POST /content-claims/:id/targets/:targetId/preview`
 * (staff, `content:claims`) mints this token, and `GET
 * /content-claims/:id/targets/:targetId/content?pt=…` streams the bytes on it.
 *
 * Deliberately narrow: bound to ONE claim, ONE target and ONE file, to the
 * reviewer it was minted for, and to {@link CLAIM_PREVIEW_TOKEN_TTL_SECONDS};
 * HMAC-SHA256 under its own derived key (`serverKey.ts`,
 * `contentClaimPreview`), so it verifies as nothing else and nothing else
 * verifies as it. It authorizes reading those bytes and nothing more.
 */

import crypto from 'node:crypto';
import { derivedServerKey, SERVER_KEY_LABELS } from '../../utils/serverKey';

/** Five minutes: long enough to load a video, short enough that a leaked URL dies quickly. */
export const CLAIM_PREVIEW_TOKEN_TTL_SECONDS = 300;

/** The query parameter carrying it. */
export const CLAIM_PREVIEW_TOKEN_PARAM = 'pt';

interface ClaimPreviewClaims {
  /** Claim. */
  c: string;
  /** Target. */
  t: string;
  /** File. */
  f: string;
  /** The reviewer. */
  u: string;
  /** Expiry, unix seconds. */
  e: number;
}

function mac(payload: string): string {
  return crypto
    .createHmac('sha256', derivedServerKey(SERVER_KEY_LABELS.contentClaimPreview))
    .update(payload)
    .digest('base64url');
}

/** Mint a token for one reviewer to read one target's file. */
export function signClaimPreviewToken(
  input: { claimId: string; targetId: string; fileId: string; userId: string },
  now: Date = new Date(),
): { token: string; expiresAt: Date } {
  const expires = Math.floor(now.getTime() / 1000) + CLAIM_PREVIEW_TOKEN_TTL_SECONDS;
  const claims: ClaimPreviewClaims = {
    c: input.claimId,
    t: input.targetId,
    f: input.fileId,
    u: input.userId,
    e: expires,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { token: `${payload}.${mac(payload)}`, expiresAt: new Date(expires * 1000) };
}

/**
 * The file id a token grants for this claim and target, or `null` for a
 * token that is malformed, forged, expired or minted for something else.
 */
export function verifyClaimPreviewToken(
  token: string,
  expected: { claimId: string; targetId: string },
  now: Date = new Date(),
): { fileId: string; userId: string } | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(signature);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  let claims: Partial<ClaimPreviewClaims>;
  try {
    claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Partial<ClaimPreviewClaims>;
  } catch {
    return null;
  }
  if (
    claims.c !== expected.claimId ||
    claims.t !== expected.targetId ||
    typeof claims.f !== 'string' ||
    typeof claims.u !== 'string' ||
    typeof claims.e !== 'number' ||
    claims.e * 1000 <= now.getTime()
  ) {
    return null;
  }
  return { fileId: claims.f, userId: claims.u };
}
