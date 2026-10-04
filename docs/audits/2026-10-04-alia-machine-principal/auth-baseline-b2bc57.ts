import { Request, Response, NextFunction } from 'express';
import {
  OxyServer,
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  createOxyRequesterAssertionAuth,
  OXY_REQUESTER_ASSERTION_HEADER,
  type OxyAuthRefusal,
  type OxyRequestUser,
  type OxyRequesterContext,
  type OxyServiceAppContext,
  type OxyServiceActingAsContext,
} from '@oxy.so/core/server';
import { log } from '../lib/logger.js';
import { getConfiguredChannels } from '../lib/channels/registry.js';
import { oxyServiceClient } from '../lib/oxy-service-client.js';

// Initialize Oxy client
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
export const oxyClient = new OxyServer({
  baseURL: OXY_API_URL,
});

// Extend Express Request for Oxy users and service tokens
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      accessToken?: string;
      user?: OxyRequestUser | null;
      serviceApp?: OxyServiceAppContext;
      /** Present only after Oxy verified the app's delegation grant for X-Oxy-User-Id. */
      serviceActingAs?: OxyServiceActingAsContext;
      /**
       * Present only after a product's requester assertion was verified against
       * Oxy's JWKS, bound to the verified service token and consumed through
       * Oxy's live introspection (ADR 0025 in OxyHQServices). The requester was
       * signed in to that product when the turn was sent.
       */
      oxyRequester?: OxyRequesterContext;
    }
  }
}

/**
 * Oxy authentication middleware (official @oxy.so/core/server)
 * Validates JWT tokens (including service tokens) and sets req.userId, req.user, req.accessToken
 */
/**
 * What Alia writes down when Oxy refuses a credential.
 *
 * The SDK answers a fixed body and tells the caller nothing, which is right —
 * and on the optional path a refusal used to leave no trace at all: the request
 * arrived unauthenticated and the generic 401 was the whole story. Oxy served
 * `{"keys":[]}` from its JWKS with no signing key bound, every service token
 * failed, Alia logged nothing and Homiio saw a 401. `code` is stable and
 * greppable; nothing here reaches a response.
 */
const onOxyRefusal = ({ code, stage, reason, status, optional }: OxyAuthRefusal): void => {
  log.auth.warn({ code, stage, reason, status, optional }, 'Oxy refused a credential');
};

const oxyAuthOptions = { auth: { debug: true, onRefusal: onOxyRefusal } } as const;

/** The same observer on the service-only lane, which `serviceAuth` forwards. */
const oxyServiceAuthOptions = { debug: true, onRefusal: onOxyRefusal } as const;

const userTokenAuth = createOxyAuthMiddleware(oxyClient, oxyAuthOptions);

/** Optional Oxy auth: verifies a token when present (service tokens set `req.serviceApp`), never refuses. */
const optionalUserTokenAuth = createOptionalOxyAuth(oxyClient, oxyAuthOptions);

/**
 * The header a service sets to say "I am acting for this person".
 *
 * Read as a constant so the delegation lane is chosen in ONE place. Nothing
 * here grants anything on the strength of it: the grant is Oxy's answer to
 * `GET /internal/service-acting-as/verify`, which the middleware below asks for
 * on every delegated request.
 */
const OXY_DELEGATED_USER_HEADER = 'x-oxy-user-id';

type AuthLane = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * A DELEGATED request needs a verifier that can prove who IT is.
 *
 * `@oxy.so/core` answers `X-Oxy-User-Id` by asking Oxy whether an explicit
 * `acting-as:offline` grant exists for `(appId, userId)` — and that endpoint is
 * service-to-service, so the SDK presents the VERIFIER's own service token to
 * reach it. `oxyClient` has no credential (it is the token-verifying client and
 * is correct without one), so `getServiceToken()` threw, the SDK logged
 * `Service credentials not provided`, cached a negative result for 60s and
 * answered `403 SERVICE_ACTING_AS_UNAUTHORIZED` — to a caller holding a
 * perfectly valid grant. Alia could never accept an offline delegation. The
 * production chat canary presents exactly this shape, and the C3 check in core
 * is right: a service may only act as a user with an explicit grant. The
 * missing piece was Alia's ability to ASK.
 *
 * So the lane is chosen per request: plain traffic keeps the credential-free
 * client, and a request that claims delegation is verified by Alia's own
 * credentialed client (`lib/oxy-service-client.ts`) — the same one that
 * introspects requester assertions.
 *
 * Built lazily and rebuilt only if the credentialed client itself changes,
 * because `oxyServiceClient()` reads the environment on first use and caches
 * the minted service token on the INSTANCE. One instance per client keeps one
 * token cache and one JWKS cache.
 *
 * @param plain the lane for a request that claims no delegation
 * @param build the same lane, built against a credentialed verifier
 * @param whenUnverifiable `refuse` answers 503 rather than denying a valid
 *   grant with a misleading 403; `continue` is for the OPTIONAL lane, which may
 *   not invent a new way to fail.
 */
function delegationAware<Lane extends AuthLane>(
  plain: Lane,
  build: (verifier: OxyServer) => Lane,
  whenUnverifiable: 'refuse' | 'continue',
): Lane {
  let delegated: Lane | undefined;
  let builtFrom: OxyServer | undefined;

  const dispatch: AuthLane = (req, res, next) => {
    if (req.headers[OXY_DELEGATED_USER_HEADER] === undefined) {
      void plain(req, res, next);
      return;
    }

    const verifier = oxyServiceClient();
    if (!verifier) {
      // Only reachable in a process that never ran the boot guards: being able
      // to mint an Oxy service token — from a credential pair, or by attesting
      // the ECS task role (oxy ADR 0026) — is already required before the socket
      // opens (`lib/boot-guards.ts` → `unsetOxyInferenceCredentialVariables`),
      // and `lib/oxy-service-client.ts` builds this verifier from the same
      // capability. Answering 503 with a name is
      // still the point: the alternative is refusing every delegated user with
      // a 403 that says they have no grant, which is a lie about somebody
      // else's configuration.
      if (whenUnverifiable === 'refuse') {
        log.auth.error(
          { path: req.path },
          'Delegated request refused: Alia holds no Oxy service credential to check the acting-as grant with',
        );
        res.status(503).json({
          error: 'SERVICE_DELEGATION_UNAVAILABLE',
          code: 'delegation_unverifiable',
          message: 'Delegated requests cannot be verified by this deployment',
          status: 503,
        });
        return;
      }
      void plain(req, res, next);
      return;
    }

    if (builtFrom !== verifier) {
      delegated = build(verifier);
      builtFrom = verifier;
    }
    void (delegated as Lane)(req, res, next);
  };
  // The dispatcher IS whichever lane it wraps, and saying so keeps each mount's
  // own inference: Express reads `:planId` off the route only while every
  // handler on it still carries the SDK's exact middleware type.
  return dispatch as unknown as Lane;
}

/**
 * Oxy authentication for a user bearer OR a service token, delegated or not.
 *
 * A delegated service token is verified by the credentialed client; everything
 * else keeps the credential-free one.
 */
export const authenticateToken = delegationAware(
  userTokenAuth,
  (verifier) => createOxyAuthMiddleware(verifier, oxyAuthOptions),
  'refuse',
);

const oxyOptionalAuth = delegationAware(
  optionalUserTokenAuth,
  (verifier) => createOptionalOxyAuth(verifier, oxyAuthOptions),
  'continue',
);

/**
 * `@oxy.so/core` 3 types this middleware's `req.user` as its own `User`, while
 * this app's Express augmentation (above) says `OxyRequestUser`; both describe
 * the same object the middleware sets. Viewed as an `AuthLane` so the lanes
 * below compose; the runtime function is the SDK's, untouched.
 */
const asAuthLane = (lane: unknown): AuthLane => lane as AuthLane;

const serviceOnlyAuth = asAuthLane(oxyClient.middleware.service(oxyServiceAuthOptions));

/**
 * Service-only auth — rejects anything that isn't a service token.
 * Use for internal-only endpoints (e.g., /internal/trigger).
 *
 * Alia deliberately supplies no private verification secret. The compatible
 * `@oxy.so/core` release verifies Ed25519 service tokens against Oxy's public
 * `/.well-known/jwks.json`, including issuer, audience, lifetime, type and
 * scopes. The middleware fails closed when that endpoint or exact `kid` is not
 * available. Never add `ACCESS_TOKEN_SECRET` or a private signing key here.
 *
 * `/internal/trigger` is a DELEGATED surface — it documents `X-Oxy-User-Id` and
 * refuses without a `req.userId` — so it takes the same lane split as
 * `authenticateToken`: the acting-as grant is checked by a verifier that can
 * present its own service token.
 */
export const oxyServiceAuth = delegationAware(
  serviceOnlyAuth,
  (verifier) => asAuthLane(verifier.middleware.service(oxyServiceAuthOptions)),
  'refuse',
);

/**
 * The audience name Oxy mints present-requester assertions for.
 */
export const ALIA_REQUESTER_ASSERTION_AUDIENCE = 'alia';

let requesterAssertionAuth: ReturnType<typeof createOxyRequesterAssertionAuth> | undefined;

/**
 * Accepts `X-Oxy-Requester-Assertion` beside a verified product service token
 * (ADR 0025 in OxyHQServices): a signed-in person chatting in a first-party
 * product reaches that product's native agent without any consent grant, and
 * without the product forwarding the person's bearer to Alia.
 *
 * Mounted after `authenticateTokenOrApiKey`, only on `/v1/chat/completions`.
 * Without the header it does nothing. With it, the request is refused unless
 * the assertion verifies against Oxy's JWKS, was minted for exactly the
 * presenting application and credential, and Oxy's introspection consumes it
 * live — which Oxy only lets ALIA's own credential do. So the introspecting
 * client is Alia's service client, never `oxyClient` (which has no credential)
 * and never anything derived from the request.
 *
 * `req.user` is then the requester from the verified claims; nothing about the
 * identity is read from a header.
 */
export function authenticateRequesterAssertion(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.headers[OXY_REQUESTER_ASSERTION_HEADER] === undefined) {
    next();
    return;
  }
  const introspector = oxyServiceClient();
  if (!introspector) {
    log.auth.error('Requester assertion received but Alia has no Oxy service credential to introspect it');
    res.status(503).json({
      error: 'REQUESTER_ASSERTION_UNAVAILABLE',
      code: 'introspection_unavailable',
      message: 'The requester assertion was not accepted',
      status: 503,
    });
    return;
  }
  requesterAssertionAuth ??= createOxyRequesterAssertionAuth(introspector, {
    audience: ALIA_REQUESTER_ASSERTION_AUDIENCE,
    onRejected: ({ code, status, applicationId }) => {
      log.auth.warn({ code, status, appId: applicationId }, 'Requester assertion rejected');
    },
  });
  void requesterAssertionAuth(req, res, next);
}

/** Test seam: the middleware closes over the service client it was built with. */
export function resetRequesterAssertionAuth(): void {
  requesterAssertionAuth = undefined;
}

/**
 * Optional auth - attaches user if token present, doesn't block if absent
 * Tries bot auth first (Telegram), then Oxy JWT auth
 */

export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Check if this is a Telegram bot request
  const telegramBotSecret = req.headers['x-telegram-bot-secret'] as string;
  if (telegramBotSecret) {
    void authenticateTelegramBot(req, res, next);
    return;
  }

  // Uses @oxy.so/core/server optional auth — attaches user if valid, continues if not.
  oxyOptionalAuth(req, res, next);
}

/**
 * Refuse a retired `alia_sk_*` key with a body that says so.
 *
 * Alia-issued developer keys were retired by the owner's clean cut: the
 * `developer_apps` / `developer_api_keys` tables are gone, so no such key can
 * authenticate anywhere. The refusal is explicit rather than an accident of the
 * Oxy SDK refusing a string that is not a JWT. Credentials for Alia's API come
 * from Oxy (ADR 0010); Alia issues and accepts none of its own.
 */
export function refuseRetiredAliaKey(res: Response): void {
  res.status(401).json({
    error: 'credential_retired',
    message: 'Alia API keys (alia_sk_*) have been retired and are no longer accepted. Authenticate with Oxy.',
  });
}

/**
 * Accepts an Oxy user or service token, plus the Telegram and channel bot
 * secrets. The name keeps "API key" because this is where the Oxy Console
 * application-key lane lands once Oxy and `@oxy.so/core/server` provide it
 * (ADR 0010 §2); today no API key of any kind is accepted.
 */
export function authenticateTokenOrApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Already authenticated (e.g., by channel bot pre-middleware)
  if (req.user) {
    return next();
  }

  // A present-requester assertion (ADR 0025) carries the identity, and the
  // product's own SERVICE token carries the caller — so this request has no
  // user bearer by design. `authenticateToken` requires a user and answered 401
  // before `authenticateRequesterAssertion` could ever look at the header, which
  // is why Sindi's chat kept failing after the rest of the lane shipped. Verify
  // the service token WITHOUT requiring a user and let the assertion middleware
  // (mounted right after, on the chat surface) accept or refuse it; a request
  // that carries the header and no valid assertion is refused there, never here.
  if (req.headers[OXY_REQUESTER_ASSERTION_HEADER] !== undefined) {
    oxyOptionalAuth(req, res, next);
    return;
  }

  // Check for Telegram bot authentication first
  const telegramBotSecret = req.headers['x-telegram-bot-secret'] as string;
  if (telegramBotSecret) {
    void authenticateTelegramBot(req, res, next);
    return;
  }

  // Channel bot secret (used by integrations service)
  const channelBotSecret = req.headers['x-channel-bot-secret'] as string;
  if (channelBotSecret) {
    void authenticateChannelBotSecret(req, res, next);
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (token.startsWith('alia_sk_')) {
    refuseRetiredAliaKey(res);
    return;
  }

  // Oxy JWT auth
  authenticateToken(req, res, next);
}

/**
 * Authenticate internal Telegram bot requests
 * The bot is a trusted server component that can act on behalf of linked users
 *
 * Security layers:
 * 1. Verifies bot secret matches server-side secret
 * 2. Validates user ID is provided
 * 3. Uses constant-time comparison to prevent timing attacks
 * 4. Logs authentication attempts for audit trail
 */
export async function authenticateTelegramBot(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const startTime = Date.now();

  try {
    const botSecret = req.headers['x-telegram-bot-secret'] as string;
    const oxyUserId = req.headers['x-oxy-user-id'] as string;
    const telegramId = req.headers['x-telegram-id'] as string;

    // Verify bot secret is configured
    const expectedSecret = process.env.TELEGRAM_BOT_SECRET;
    if (!expectedSecret) {
      log.auth.error('TELEGRAM_BOT_SECRET not configured');
      res.status(500).json({ error: 'Bot authentication not configured' });
      return;
    }

    // Verify secret provided
    if (!botSecret) {
      log.auth.warn('Missing bot secret');
      res.status(401).json({ error: 'Bot authentication required' });
      return;
    }

    // Use crypto.timingSafeEqual to prevent timing attacks
    const expectedBuffer = Buffer.from(expectedSecret);
    const providedBuffer = Buffer.from(botSecret);

    if (expectedBuffer.length !== providedBuffer.length) {
      log.auth.warn('Invalid bot secret length');
      res.status(401).json({ error: 'Invalid bot authentication' });
      return;
    }

    const crypto = await import('crypto');
    if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      log.auth.warn('Invalid bot secret');
      res.status(401).json({ error: 'Invalid bot authentication' });
      return;
    }

    // Verify telegram ID is provided
    if (!telegramId) {
      log.auth.warn('Missing telegram ID in bot request');
      res.status(400).json({ error: 'Telegram ID required for bot requests' });
      return;
    }

    // Log successful auth for audit trail
    const duration = Date.now() - startTime;
    log.auth.info({ telegramId, oxyUserId: oxyUserId || 'unknown', endpoint: req.path, durationMs: duration }, 'Telegram bot authenticated');

    // Set user context if provided - the bot is acting on behalf of this user
    if (oxyUserId) {
      req.userId = oxyUserId;
      req.user = { id: oxyUserId };
    }
    next();
  } catch (error) {
    log.auth.error({ err: error }, 'Bot authentication error');
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Authenticate requests from the integrations service using a generic channel bot secret.
 *
 * Security layers:
 * 1. Reads `X-Channel-Bot-Secret` header and matches it against every
 *    configured channel's `config.getBotSecret()` using constant-time comparison
 * 2. Requires `X-Oxy-User-Id` header so the request carries user context
 * 3. Logs authentication attempts for audit trail
 */
export async function authenticateChannelBotSecret(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const channelBotSecret = req.headers['x-channel-bot-secret'] as string;
    const oxyUserId = req.headers['x-oxy-user-id'] as string;

    if (!channelBotSecret) {
      res.status(401).json({ error: 'Channel bot authentication required' });
      return;
    }

    if (!oxyUserId) {
      log.auth.warn('Missing X-Oxy-User-Id in channel bot request');
      res.status(401).json({ error: 'User context required for channel bot requests' });
      return;
    }

    // Validate oxyUserId is a valid 24-char hex ObjectId to prevent injection
    if (!/^[a-f0-9]{24}$/.test(oxyUserId)) {
      log.auth.warn({ oxyUserId }, 'Invalid oxyUserId format in channel bot request');
      res.status(400).json({ error: 'Invalid user ID format' });
      return;
    }

    const crypto = await import('crypto');
    const configuredChannels = getConfiguredChannels();
    const providedBuffer = Buffer.from(channelBotSecret);
    let matched = false;

    for (const channel of configuredChannels) {
      const expectedSecret = channel.config.getBotSecret();
      if (!expectedSecret) continue;

      const expectedBuffer = Buffer.from(expectedSecret);
      if (expectedBuffer.length !== providedBuffer.length) continue;

      if (crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
        matched = true;
        break;
      }
    }

    if (!matched) {
      log.auth.warn('Invalid channel bot secret');
      res.status(401).json({ error: 'Invalid channel bot authentication' });
      return;
    }

    log.auth.info(
      { oxyUserId, endpoint: req.path },
      'Channel bot authenticated'
    );

    req.userId = oxyUserId;
    req.user = { id: oxyUserId };
    next();
  } catch (error) {
    log.auth.error({ err: error }, 'Channel bot authentication error');
    res.status(500).json({ error: 'Authentication failed' });
  }
}
