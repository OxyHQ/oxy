/**
 * `/session/browser-hub/*` — the browser DeviceSession hub's server half
 * (issue #937 Phase 5, ADR 0003).
 *
 * ## Who speaks this, and who must not
 *
 * ONLY the IdP's own server/edge layer at `auth.oxy.so`. Three of the four
 * endpoints here take the RAW hub handle in a request body, and that value is
 * the browser's device credential — it lives in an `HttpOnly` cookie precisely
 * so no script can reach it. A page that could call these would be holding the
 * thing the cookie flag exists to withhold.
 *
 * Nothing enforces "you are the edge" beyond that, and nothing needs to: the
 * handle IS the credential (`establish` is the exception and takes a
 * first-party bearer instead). The same reasoning as `POST
 * /session/device/token`, one credential class along.
 *
 * ## What this reopens of the zero-cookie posture, and what it does not
 *
 * Exactly one mechanism at exactly one origin. Relying-party origins remain
 * zero-cookie: `{deviceId, deviceSecret}` + `POST /session/device/token`, no
 * cookie of any kind. `auth.oxy.so` alone holds a host-only, `HttpOnly`, opaque
 * handle, first-party only. No refresh-token family and no bootstrap hop return
 * — the handle is a pointer to a server-side device session, never something the
 * browser can spend against the resource API.
 *
 * NO endpoint here sets a cookie. Express cannot: a `__Host-` cookie is bound to
 * the host that sends it, and this API answers on `api.oxy.so`. The cookie is
 * written by the edge at `auth.oxy.so`, which is the only place it can be.
 */

import { Router, type Request, type Response } from 'express';
import type {
  BrowserHubHandleResponse,
  BrowserHubResolveResponse,
  BrowserHubRevokeResponse,
} from '@oxyhq/contracts';
import {
  browserHubHandleRequestSchema,
  browserHubHandleResponseSchema,
  browserHubResolveResponseSchema,
  browserHubRevokeResponseSchema,
} from '@oxyhq/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { requireFirstPartyDeviceAccess } from '../middleware/firstPartyDeviceAccess';
import { requireSameSiteOrigin } from '../middleware/originGuard';
import { decodeToken, extractTokenFromRequest } from '../middleware/authUtils';
import { rateLimit } from '../middleware/rateLimiter';
import deviceSessionService from '../services/deviceSession.service';
import { sha256Hex } from '../services/oauthCode.service';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Per-HANDLE budgets, not per-IP.
 *
 * Every request on this router arrives from Cloudflare's edge, so an IP key
 * would collapse the entire hub onto a handful of buckets and let one abusive
 * browser rate-limit the whole world. The handle's own hash gives each browser
 * its own budget.
 *
 * That deliberately does NOT bound guessing — an attacker rotates the handle
 * each attempt and lands on a fresh key every time. It is not supposed to: the
 * control against guessing a 256-bit random value is the 256 bits, and a limiter
 * that pretended otherwise would only be theatre. What this bounds is a real
 * browser (or a real leaked handle) hammering one credential.
 *
 * The key is a PREFIX of the same hash the lookup uses, never the raw handle: a
 * Redis key is not a secret store, and this one appears in `MONITOR`, in
 * keyspace dumps and in anything that samples slow commands.
 */
function perHandleKey(scope: string) {
  return (req: Request) => {
    const body: unknown = req.body;
    const handle =
      typeof body === 'object' && body !== null && 'handle' in body && typeof body.handle === 'string'
        ? body.handle
        : null;
    if (!handle) return `${scope}:absent`;
    return `${scope}:${sha256Hex(handle).slice(0, 32)}`;
  };
}

/**
 * Establish is bearer-gated, so it is keyed on the device the bearer names —
 * the same shape `/session/device/*` uses. A browser establishes a hub once per
 * authentication; the ceiling only has to sit above a user retrying.
 */
const hubEstablishLimiter = rateLimit({
  prefix: 'rl:session:hub-establish:',
  windowMs: 60_000,
  max: 20,
  keyGenerator: (req) => {
    const token = extractTokenFromRequest(req as AuthRequest);
    const decoded = token ? decodeToken(token) : null;
    return `hub-establish:${decoded?.deviceId ?? 'unknown'}`;
  },
});

// The edge resolves once per authorize round trip and once per SPA cold boot.
const hubResolveLimiter = rateLimit({
  prefix: 'rl:session:hub-resolve:',
  windowMs: 60_000,
  max: 60,
  keyGenerator: perHandleKey('hub-resolve'),
});

// Rotation is a sensitive transition, not a poll.
const hubRotateLimiter = rateLimit({
  prefix: 'rl:session:hub-rotate:',
  windowMs: 60_000,
  max: 10,
  keyGenerator: perHandleKey('hub-rotate'),
});

// Revocation is idempotent and terminal; the budget only stops a loop.
const hubRevokeLimiter = rateLimit({
  prefix: 'rl:session:hub-revoke:',
  windowMs: 60_000,
  max: 10,
  keyGenerator: perHandleKey('hub-revoke'),
});

/**
 * POST /session/browser-hub/establish — bind a hub handle to the caller's
 * device. Bearer REQUIRED; no body.
 *
 * The bearer is the whole control, exactly as it is for
 * `/session/device/background-credential`: the device is read from the token
 * rather than the request, so a caller can only ever establish a hub for the
 * device it is already authenticated on. A third-party OAuth bearer is refused
 * before this handler runs.
 *
 * The raw handle is returned exactly ONCE. The edge writes it straight into
 * `__Host-oxy-device` and keeps no copy; it is never logged here or there.
 */
router.post(
  '/establish',
  requireSameSiteOrigin,
  authMiddleware,
  requireFirstPartyDeviceAccess,
  hubEstablishLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const token = extractTokenFromRequest(req);
    const deviceId = token ? decodeToken(token)?.deviceId : null;
    if (!deviceId) {
      res.status(401).json({ error: 'No device' });
      return;
    }

    const issued = await deviceSessionService.issueHubHandle(deviceId);
    if (!issued) {
      res.status(401).json({ error: 'No device' });
      return;
    }

    // The lane and the device, never the handle or its hash.
    logger.info('device.hub.established', { deviceId });
    const dto: BrowserHubHandleResponse = issued;
    res.json({ data: browserHubHandleResponseSchema.parse(dto) });
  })
);

/**
 * POST /session/browser-hub/resolve — the browser's device session, from the
 * handle alone. NO bearer: possession of the handle IS the proof.
 *
 * Returns the directory plus a short access token for the device's active
 * context. That token is what lets the edge run the authorize lane on the
 * browser's behalf, and it stops at the edge — the SPA never receives it.
 *
 * `invalid_handle` and `no_active_session` are different answers on purpose. The
 * first must make the edge clear the cookie; the second must not, because the
 * credential is fine and the browser simply has nothing signed in.
 */
router.post(
  '/resolve',
  hubResolveLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = browserHubHandleRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'handle is required' });
      return;
    }

    const deviceId = await deviceSessionService.resolveHubDeviceId(parsed.data.handle);
    if (!deviceId) {
      res.status(401).json({ error: 'invalid_handle' });
      return;
    }

    const state = await deviceSessionService.getState(deviceId);
    const activeToken = await deviceSessionService.resolveActiveToken(state);
    if (!activeToken) {
      res.status(401).json({ error: 'no_active_session' });
      return;
    }

    const directory = await deviceSessionService.getDirectory(deviceId);
    logger.info('device.hub.resolved', { deviceId });
    const dto: BrowserHubResolveResponse = {
      accessToken: activeToken.accessToken,
      expiresAt: activeToken.expiresAt,
      directory,
    };
    res.json({ data: browserHubResolveResponseSchema.parse(dto) });
  })
);

/**
 * POST /session/browser-hub/rotate — replace the handle a browser holds.
 *
 * The presented handle is the proof, so a rotation cannot be requested for
 * somebody else's browser. The previous hash stays valid for a short grace
 * window; see the schema module for why a shared cookie jar makes that
 * necessary rather than merely kind.
 */
router.post(
  '/rotate',
  hubRotateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = browserHubHandleRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'handle is required' });
      return;
    }

    const deviceId = await deviceSessionService.resolveHubDeviceId(parsed.data.handle);
    if (!deviceId) {
      res.status(401).json({ error: 'invalid_handle' });
      return;
    }

    const issued = await deviceSessionService.issueHubHandle(deviceId);
    if (!issued) {
      res.status(401).json({ error: 'invalid_handle' });
      return;
    }

    logger.info('device.hub.rotated', { deviceId });
    const dto: BrowserHubHandleResponse = issued;
    res.json({ data: browserHubHandleResponseSchema.parse(dto) });
  })
);

/**
 * POST /session/browser-hub/revoke — sign out of `auth.oxy.so`.
 *
 * Clears the hub credential and NOTHING else: the device session, its
 * principals and every other app on the device are untouched. Revoking the
 * browser's whole device session is `POST /session/device/signout` with
 * `{ all: true }`, which sweeps these columns as part of the same transaction.
 *
 * Answers 200 either way. A handle that resolves to nothing has already achieved
 * what the caller asked for, and reporting 401 would turn the endpoint into an
 * oracle for whether a value was ever real.
 */
router.post(
  '/revoke',
  hubRevokeLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = browserHubHandleRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'handle is required' });
      return;
    }

    const revoked = await deviceSessionService.revokeHubHandle(parsed.data.handle);
    if (revoked) logger.info('device.hub.revoked', {});
    const dto: BrowserHubRevokeResponse = { revoked };
    res.json({ data: browserHubRevokeResponseSchema.parse(dto) });
  })
);

export default router;
