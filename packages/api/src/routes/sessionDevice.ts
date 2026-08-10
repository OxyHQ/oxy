import { Router, type Request, type Response } from 'express';
import type { DeviceSessionState } from '@oxyhq/contracts';
import {
  deviceBackgroundTokenRequestSchema,
  deviceTokenMintRequestSchema,
} from '@oxyhq/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { requireSameSiteOrigin } from '../middleware/originGuard';
import { decodeToken, extractTokenFromRequest } from '../middleware/authUtils';
import { rateLimit } from '../middleware/rateLimiter';
import { isLockedOut, recordFailure, clearFailures } from '../services/loginLockout.service';
import deviceSessionService from '../services/deviceSession.service';
import sessionService from '../services/session.service';
import { broadcastDeviceState, broadcastSessionAccountsChanged } from '../utils/socket';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../utils/logger';
import { isBrowserClient } from '../utils/origin';
import { hashedIpKey } from '../utils/ipKey';

const router = Router();

/** Lockout scope for the public deviceSecret mint (per-deviceId sliding window). */
const DEVICE_TOKEN_LOCKOUT_SCOPE = 'device-token';

const deviceTokenLimiter = rateLimit({
  prefix: 'rl:session:device-token:',
  windowMs: 60_000,
  max: 30,
});

const backgroundTokenLimiter = rateLimit({
  prefix: 'rl:session:background-token:',
  windowMs: 60_000,
  max: 30,
});

/** Lockout scope for the public background-token mint (per-deviceId). */
const BACKGROUND_TOKEN_LOCKOUT_SCOPE = 'background-token';

/**
 * POST /session/device/token — the phase-2c zero-cookie mint.
 *
 * PUBLIC by design and mounted ABOVE the router-wide
 * `requireSameSiteOrigin, authMiddleware` below: it carries NO bearer and NO
 * cookies. The client presents the `deviceId` it stored first-party plus the
 * opaque `deviceSecret`; possession of the secret IS the ownership proof, so the
 * mint can be initiated from any registered cross-apex origin over normal CORS.
 *
 * On a valid secret it mints a short access token for the device's active
 * account. The successful response carries the same secret back as
 * `nextDeviceSecret`: the secret is a stable device credential, so several
 * official apps/origins sharing one device can refresh concurrently without
 * invalidating one another. A dead/absent active session returns
 * `no_active_session` WITHOUT changing the credential — the client must
 * re-authenticate and keeps its still-valid secret. Per-device lockout + rate
 * limiting blunt online secret-guessing.
 *
 * An optional `accountId` PINS the mint to one account of that device instead of
 * whichever one is currently active. It exists for identity-bound clients
 * (Commons), whose authenticated user is fixed by a local cryptographic key and
 * must not follow an account switch made by another app sharing the same
 * `DeviceSession`. A pinned mint is READ-ONLY with respect to device state: it
 * never writes `activeAccountId`, never bumps `revision` and never broadcasts —
 * the returned `state` therefore still reports the device's TRUE active account.
 * Rotation is unchanged. A pin that names an account which is not on the device,
 * or whose session is dead, answers `account_not_on_device` without rotating.
 */
router.post(
  '/token',
  deviceTokenLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = deviceTokenMintRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'deviceId and deviceSecret are required' });
      return;
    }
    const { deviceId, deviceSecret, accountId } = parsed.data;

    const lockout = await isLockedOut({ scope: DEVICE_TOKEN_LOCKOUT_SCOPE, identifier: deviceId });
    if (lockout.locked) {
      if (typeof lockout.retryAfterSeconds === 'number') {
        res.setHeader('Retry-After', String(lockout.retryAfterSeconds));
      }
      res.status(429).json({ error: 'Too many attempts' });
      return;
    }

    const state = await deviceSessionService.getStateBySecret(deviceId, deviceSecret);
    if (!state) {
      await recordFailure({ scope: DEVICE_TOKEN_LOCKOUT_SCOPE, identifier: deviceId });
      res.status(401).json({ error: 'invalid_device_secret' });
      return;
    }

    // The secret matched — clear the failure counter regardless of whether the
    // device currently has a live active session.
    await clearFailures({ scope: DEVICE_TOKEN_LOCKOUT_SCOPE, identifier: deviceId });

    // A pinned mint resolves the named account instead of the active one. The
    // resolver returns null both when the account is not registered on this
    // device and when its session is dead — deliberately indistinguishable: the
    // secret is already proven at this point, so a pinned miss must not become
    // an account-existence oracle.
    const mintedToken = accountId
      ? await deviceSessionService.resolveTokenForAccount(state, accountId)
      : await deviceSessionService.resolveActiveToken(state);
    if (!mintedToken) {
      // Known device, but nothing live to mint for. Do NOT rotate — the client
      // re-authenticates (or drops its pin) and keeps its still-valid secret.
      res.status(401).json({ error: accountId ? 'account_not_on_device' : 'no_active_session' });
      return;
    }

    // Telemetry carries the lane and the pin discriminator only — never the
    // pinned accountId, the secret, or any other user-identifying value.
    logger.info('device.token.mint', { mint_source: 'secret', deviceId, ...(accountId ? { pinned: true } : {}) });
    res.json({
      data: {
        accessToken: mintedToken.accessToken,
        expiresAt: mintedToken.expiresAt,
        // Keep the proven credential stable. Rotating here makes separate
        // first-party origins race over one DeviceSession secret and causes
        // otherwise healthy sessions to disappear after the grace window.
        nextDeviceSecret: deviceSecret,
        // The device's TRUE state — a pin never rewrites `activeAccountId`, and
        // the response must not pretend otherwise.
        state,
      },
    });
  }),
);

/**
 * POST /session/device/background-token — bearer-less mint for native background
 * code. Possession of the provisioned background secret IS the proof; the secret
 * is NEVER rotated (unlike `POST /token`). Returns only the short access token,
 * its expiry, and the account it belongs to — no device state.
 */
router.post(
  '/background-token',
  backgroundTokenLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = deviceBackgroundTokenRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'deviceId and secret are required' });
      return;
    }
    const { deviceId, secret } = parsed.data;

    const lockout = await isLockedOut({ scope: BACKGROUND_TOKEN_LOCKOUT_SCOPE, identifier: deviceId });
    if (lockout.locked) {
      if (typeof lockout.retryAfterSeconds === 'number') {
        res.setHeader('Retry-After', String(lockout.retryAfterSeconds));
      }
      res.status(429).json({ error: 'Too many attempts' });
      return;
    }

    const outcome = await deviceSessionService.mintFromBackgroundSecret(deviceId, secret);
    if (!outcome.ok) {
      if (outcome.reason === 'background_credential_invalid') {
        await recordFailure({ scope: BACKGROUND_TOKEN_LOCKOUT_SCOPE, identifier: deviceId });
      } else {
        // The credential was proven — a dead bound account must not count as
        // secret guessing.
        await clearFailures({ scope: BACKGROUND_TOKEN_LOCKOUT_SCOPE, identifier: deviceId });
      }
      res.status(401).json({ error: outcome.reason });
      return;
    }

    await clearFailures({ scope: BACKGROUND_TOKEN_LOCKOUT_SCOPE, identifier: deviceId });
    logger.info('device.token.mint', { mint_source: 'background', deviceId });
    res.json({
      data: {
        accessToken: outcome.accessToken,
        expiresAt: outcome.expiresAt,
        accountId: outcome.accountId,
      },
    });
  }),
);

function withoutActiveToken(state: DeviceSessionState) {
  // Bearer-authenticated device routes authorize the device, not every account
  // registered on it. Returning another account's token here would let any
  // account on the device disclose that token after changing activeAccountId.
  // Token minting remains available only through /token, where the caller must
  // prove possession of the device secret.
  return { state, activeToken: null };
}

function resolveCallerDeviceId(req: AuthRequest): string | null {
  const token = extractTokenFromRequest(req);
  const decoded = token ? decodeToken(token) : null;
  return decoded?.deviceId ?? null;
}

function resolveCallerSession(req: AuthRequest): { deviceId: string; sessionId: string } | null {
  const token = extractTokenFromRequest(req);
  const decoded = token ? decodeToken(token) : null;
  if (!decoded?.deviceId || !decoded?.sessionId) return null;
  return { deviceId: decoded.deviceId, sessionId: decoded.sessionId };
}

const backgroundCredentialLimiter = rateLimit({
  prefix: 'rl:session:background-credential:',
  windowMs: 60_000,
  max: 10,
  keyGenerator: (req) => {
    const deviceId = resolveCallerDeviceId(req as AuthRequest);
    const userId = (req as AuthRequest).user?._id?.toString();
    if (deviceId && userId) {
      return `bg-cred:${deviceId}:${userId}`;
    }
    return `bg-cred:ip:${hashedIpKey(req)}`;
  },
});

router.use(requireSameSiteOrigin, authMiddleware);

/**
 * POST /session/device/background-credential — provision a non-rotating
 * background credential for the caller's account on this device. Bearer required;
 * NO body. The raw secret is returned exactly once for native background code to
 * store — JS never mints from it. Browser callers are refused: native HTTP
 * clients send no `Origin`/`Sec-Fetch-Site`; credentialed browser fetch always
 * does, and a long-lived non-rotating secret must not be mintable from a web
 * origin even with a valid bearer.
 */
router.post(
  '/background-credential',
  backgroundCredentialLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (isBrowserClient(req.headers)) {
      res.status(403).json({ error: 'browser_not_allowed' });
      return;
    }

    const deviceId = resolveCallerDeviceId(req);
    const accountId = req.user?._id?.toString();
    if (!deviceId || !accountId) {
      res.status(401).json({ error: 'No device' });
      return;
    }

    const credential = await deviceSessionService.issueBackgroundCredential(deviceId, accountId);
    if (!credential) {
      res.status(401).json({ error: 'account_not_on_device' });
      return;
    }

    logger.info('device.background.credential.issued', { deviceId });
    res.json({ data: credential });
  }),
);

// GET /state returns the DEVICE subset (this device's registered accounts). The
// RP client additionally unions the org/shared account graph from `GET /accounts`;
// that extra graph is legitimate and is NOT part of the device subset — do not
// try to mirror it here.
router.get('/state', asyncHandler(async (req: AuthRequest, res: Response) => {
  const deviceId = resolveCallerDeviceId(req);
  if (!deviceId) { res.status(401).json({ error: 'No device' }); return; }

  res.json({ data: withoutActiveToken(await deviceSessionService.getState(deviceId)) });
}));

router.post('/add', asyncHandler(async (req: AuthRequest, res: Response) => {
  const session = resolveCallerSession(req);
  const accountId = req.user?._id?.toString();
  if (!session?.deviceId || !accountId || !session.sessionId) { res.status(401).json({ error: 'Invalid session' }); return; }
  // The bearer JWT does not carry `operatedByUserId` (it is session-doc-only),
  // so a managed-account sign-in must be resolved from the session record
  // itself to bind the device-session entry to its operator.
  const sessionDoc = await sessionService.getSession(session.sessionId, true);
  // The session record must still be active. `getSession` returns null for an
  // expired/revoked session (JWT not yet expired but the session doc
  // deactivated) — such a session must NOT be re-added to the device set.
  if (!sessionDoc) { res.status(401).json({ error: 'Invalid session' }); return; }
  // `sessions.operated_by_user_id` is a plain text id, NULL for an ordinary
  // personal session. That NULL is the whole distinction between a delegated
  // (`account:act_as`) entry and a personal one, so it is mapped to `undefined`
  // and the key is then OMITTED below rather than sent as an empty value.
  const operatedByUserId = sessionDoc.operatedByUserId ?? undefined;

  const { state, changed } = await deviceSessionService.addAccount(session.deviceId, {
    accountId,
    sessionId: session.sessionId,
    ...(operatedByUserId ? { operatedByUserId } : {}),
  });
  // An idempotent re-register (reload handoff) changes nothing — do not broadcast.
  if (changed) {
    broadcastDeviceState(state);
    // Also signal the added account's user across their other apps/devices.
    broadcastSessionAccountsChanged(accountId, state.revision, 'add');
  }
  res.json({ data: withoutActiveToken(state) });
}));

router.post('/switch', asyncHandler(async (req: AuthRequest, res: Response) => {
  const deviceId = resolveCallerDeviceId(req);
  const { accountId } = req.body ?? {};
  if (!deviceId) { res.status(401).json({ error: 'No device' }); return; }
  if (!accountId) { res.status(400).json({ error: 'accountId required' }); return; }
  const outcome = await deviceSessionService.switchActive(deviceId, accountId);
  if (!outcome.ok) {
    if (outcome.reason === 'unauthorized') {
      // The target session was revoked; `switchActive` healed the device set by
      // removing the dead account. Broadcast the healed state so the device's
      // other tabs drop it too, then reject the switch.
      broadcastDeviceState(outcome.state);
      // The dropped account was revoked — signal its user to refetch.
      broadcastSessionAccountsChanged(accountId, outcome.state.revision, 'revoke');
      res.status(403).json({ error: 'Account not authorized' });
      return;
    }
    res.status(404).json({ error: 'Account not on this device' });
    return;
  }
  broadcastDeviceState(outcome.state);
  broadcastSessionAccountsChanged(accountId, outcome.state.revision, 'switch');
  res.json({ data: withoutActiveToken(outcome.state) });
}));

router.post('/signout', asyncHandler(async (req: AuthRequest, res: Response) => {
  const deviceId = resolveCallerDeviceId(req);
  if (!deviceId) { res.status(401).json({ error: 'No device' }); return; }
  const { accountId, all } = req.body ?? {};
  const target = all === true ? { all: true as const } : accountId ? { accountId } : null;
  if (!target) { res.status(400).json({ error: 'accountId or all required' }); return; }
  // Capture the account set BEFORE signout so we can signal every user actually
  // removed — this covers `all`, a single account, AND the operator-cascade
  // (signing out an operator removes their managed accounts too).
  const before = await deviceSessionService.getState(deviceId);
  const state = await deviceSessionService.signout(deviceId, target);
  broadcastDeviceState(state);
  const remaining = new Set(state.accounts.map((a) => a.accountId));
  const removedUserIds = before.accounts
    .map((a) => a.accountId)
    .filter((id) => !remaining.has(id));
  broadcastSessionAccountsChanged(removedUserIds, state.revision, 'signout');
  res.json({ data: withoutActiveToken(state) });
}));

export default router;
