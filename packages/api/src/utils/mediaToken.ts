/**
 * Scoped media tokens — the `?mt=` credential on private-asset stream URLs.
 *
 * A browser `<img src>` / `Image.getSize()` / `<a download>` cannot send an
 * `Authorization` header, and the zero-cookie session transport means there is
 * no ambient credential either. Private assets therefore need a credential that
 * travels IN the URL — but the caller's access token must never be that
 * credential: asset URLs are rendered into DOM attributes, browser network
 * panels, HTTP caches, referrer headers, and screenshots.
 *
 * A media token is deliberately the weakest credential the platform issues:
 *
 * - **Single asset.** The `fid` claim pins the token to exactly one file id.
 *   {@link verifyMediaToken} only accepts it when `fid` equals the file id the
 *   request is actually asking for, so a token minted for asset A cannot open
 *   asset B. Variants of the same asset share one access decision, so the token
 *   is intentionally NOT pinned to a variant.
 * - **Read-only, media-only.** The `typ: 'media'` claim plus the dedicated
 *   signing key (below) mean it authorizes viewing that one asset and nothing
 *   else. It carries no session id, so it cannot satisfy any other authenticated
 *   surface.
 * - **Short-lived.** {@link MEDIA_TOKEN_TTL_SECONDS} (15 minutes). There is no
 *   revocation list; the short TTL IS the revocation story. Access changes
 *   (unfollow, block, visibility flip, delete) take effect for a leaked token
 *   within one TTL, and every fresh render re-mints through the access check.
 *
 * ## Key separation (why this cannot be confused with an access token)
 *
 * Media tokens are signed with a key DERIVED from `ACCESS_TOKEN_SECRET` rather
 * than the secret itself:
 *
 *     mediaKey = HMAC-SHA256(ACCESS_TOKEN_SECRET, MEDIA_TOKEN_KEY_LABEL)
 *
 * This reuses a secret the deploy already requires (`config/env.ts` fails boot
 * without `ACCESS_TOKEN_SECRET`, and it is already synced to SSM) — no new,
 * unconfigured env var that would break the ECS boot contract — while making the
 * two token families cryptographically disjoint:
 *
 * - A media token does NOT verify under `ACCESS_TOKEN_SECRET`, so `decodeToken`,
 *   `validateSessionToken`, and `verifyServiceToken` all reject it outright. It
 *   can never authenticate a bearer-protected route.
 * - An access/service token does NOT verify under the derived key, so it is not
 *   accepted in `?mt=` either. The two directions are both closed.
 *
 * ## Never log a token
 *
 * No function here logs a token value, and callers must not either — not in pino
 * fields, error messages, or breadcrumbs. Log the `fileId` (a public id) instead.
 */

import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';

/**
 * Domain-separation label mixed into the derived signing key. Versioned so the
 * media-token family can be rotated independently of `ACCESS_TOKEN_SECRET`
 * (bumping the label invalidates every outstanding media token at once).
 */
const MEDIA_TOKEN_KEY_LABEL = 'oxy:media-token:v1';

/**
 * Lifetime of a scoped media token, in seconds.
 *
 * Long enough to cover a page of thumbnails resolving and rendering (and a slow
 * connection finishing the byte stream); short enough that a token leaked via a
 * DOM attribute, cache, or screenshot stops working quickly. Because there is no
 * revocation list, this TTL is the upper bound on how long a revoked viewer can
 * keep reading a leaked URL.
 *
 * MUST stay STRICTLY GREATER than the `@oxy.so/core` SDK's `assetGetUrl` response
 * cache TTL (currently 10 minutes). The SDK caches the whole `GET /assets/:id/url`
 * response — including the URL with this token embedded — so a URL can be served
 * from cache up to that TTL after it was minted. A 15-minute token over a
 * 10-minute URL cache guarantees at least ~5 minutes of remaining validity on any
 * cached URL, so an `<img src>` never receives an already-expired token. If the
 * SDK cache TTL is ever raised, raise this in lockstep with the same margin.
 */
export const MEDIA_TOKEN_TTL_SECONDS = 900;

/** Query parameter carrying a scoped media token on stream/download URLs. */
export const MEDIA_TOKEN_QUERY_PARAM = 'mt';

/** Claims carried by a scoped media token. */
interface MediaTokenClaims {
  /** Token family discriminator. Always `'media'`. */
  typ: 'media';
  /** The single file id this token authorizes. */
  fid: string;
  /** The user whose access was verified when the token was minted. */
  uid: string;
}

/**
 * Raised when `ACCESS_TOKEN_SECRET` is absent at mint time. `config/env.ts`
 * requires it to boot, so this is a broken-deploy condition and must fail loudly
 * (500) rather than silently handing back a URL that will 403 on every render.
 */
export class MediaTokenNotConfiguredError extends Error {
  constructor() {
    super('Cannot mint a scoped media token: ACCESS_TOKEN_SECRET is not configured');
    this.name = 'MediaTokenNotConfiguredError';
  }
}

let cachedSourceSecret: string | undefined;
let cachedKey: Buffer | undefined;

/**
 * Derive (and memoize) the media-token signing key from `ACCESS_TOKEN_SECRET`.
 * Re-derives whenever the source secret changes so a rotated secret rotates the
 * media key with it. Returns `null` when the source secret is unset.
 */
function mediaTokenKey(): Buffer | null {
  const secret = process.env.ACCESS_TOKEN_SECRET;
  if (!secret) {
    return null;
  }
  if (!cachedKey || cachedSourceSecret !== secret) {
    cachedKey = createHmac('sha256', secret).update(MEDIA_TOKEN_KEY_LABEL).digest();
    cachedSourceSecret = secret;
  }
  return cachedKey;
}

/**
 * Mint a scoped media token authorizing `userId` to read `fileId` for the next
 * {@link MEDIA_TOKEN_TTL_SECONDS} seconds.
 *
 * The CALLER is responsible for having already verified access
 * (`assetService.canUserAccessFile`) — this function performs no authorization
 * of its own, it only binds an already-made decision to one asset and a clock.
 *
 * @throws {MediaTokenNotConfiguredError} when `ACCESS_TOKEN_SECRET` is unset.
 */
export function signMediaToken(fileId: string, userId: string): string {
  const key = mediaTokenKey();
  if (!key) {
    throw new MediaTokenNotConfiguredError();
  }

  const claims: MediaTokenClaims = { typ: 'media', fid: fileId, uid: userId };
  return jwt.sign(claims, key, {
    algorithm: 'HS256',
    expiresIn: MEDIA_TOKEN_TTL_SECONDS,
  });
}

/**
 * Verify a scoped media token against the file id the request is asking for and
 * return the authorized viewer's user id, or `undefined` for anything that does
 * not verify.
 *
 * Rejects (all as `undefined`, never throwing): a bad/absent signature, an
 * expired token, a token from another family (access/service tokens do not
 * verify under the derived key), a token whose `typ` is not `'media'`, a token
 * whose `fid` names a DIFFERENT asset, and a token with no usable `uid`.
 *
 * `fid` is compared with `!==` rather than a constant-time helper on purpose: a
 * file id is a public identifier the caller already supplied in the request
 * path, not a secret, so there is nothing to leak by timing.
 */
export function verifyMediaToken(token: string, requestedFileId: string): string | undefined {
  const key = mediaTokenKey();
  if (!key) {
    return undefined;
  }

  let decoded: Partial<MediaTokenClaims>;
  try {
    // `algorithms` is pinned so a token cannot downgrade the signature scheme.
    decoded = jwt.verify(token, key, { algorithms: ['HS256'] }) as Partial<MediaTokenClaims>;
  } catch {
    // Invalid signature, wrong token family, malformed JWT, or expired. All mean
    // the same thing here — "not an authorized viewer" — and the caller's own
    // access check still runs on the resulting anonymous viewer. Deliberately
    // not logged: the only detail available is the token value itself, which
    // must never reach a log.
    return undefined;
  }

  if (decoded.typ !== 'media') {
    return undefined;
  }
  if (typeof decoded.fid !== 'string' || decoded.fid !== requestedFileId) {
    return undefined;
  }
  if (typeof decoded.uid !== 'string' || decoded.uid.length === 0) {
    return undefined;
  }

  return decoded.uid;
}
