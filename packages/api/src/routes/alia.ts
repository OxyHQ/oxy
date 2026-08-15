import { Router, type Request, type Response, type NextFunction } from 'express';
import axios from 'axios';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { authMiddleware } from '../middleware/auth';
import { extractTokenFromRequest } from '../middleware/authUtils';
import { verifyServiceToken } from '../middleware/serviceToken';
import { asyncHandler } from '../utils/asyncHandler';
import { isCredentialUsable } from '../utils/credentialUsability';
import { logger } from '../utils/logger';
import { isTrustedApplication } from '../utils/trustedApplication';

const router = Router();

const ALIA_BASE_URL = 'https://api.alia.onl/v1';
const ALIA_API_KEY = process.env.ALIA_API_KEY;
const ALIA_PROXY_ERROR_MESSAGE = 'Failed to reach Alia API';

const isReadableStream = (value: unknown): value is NodeJS.ReadableStream => {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as NodeJS.ReadableStream).pipe === 'function' &&
    typeof (value as NodeJS.ReadableStream).on === 'function'
  );
};

const toSafeErrorMessage = (data: unknown): unknown => {
  if (data === undefined || data === null || isReadableStream(data)) {
    return ALIA_PROXY_ERROR_MESSAGE;
  }

  if (typeof data !== 'object') {
    return data;
  }

  try {
    JSON.stringify(data);
    return data;
  } catch {
    return ALIA_PROXY_ERROR_MESSAGE;
  }
};

const proxyAliaJson = async (req: Request, res: Response, path: string) => {
  const apiKey = ALIA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ALIA_API_KEY not configured on server' });
    return;
  }

  try {
    const response = await axios.post(`${ALIA_BASE_URL}${path}`, req.body, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      responseType: 'json',
    });
    res.json(response.data);
  } catch (err: any) {
    const status = err.response?.status ?? 502;
    const message = toSafeErrorMessage(err.response?.data);
    res.status(status).json({ error: 'ALIA_PROXY_ERROR', message });
  }
};

/**
 * The ONE refusal this gate produces once a caller has presented something.
 *
 * It says the endpoint is not publicly available and nothing else: not which
 * application the credential belongs to, not whether that application exists,
 * not whether the credential is merely revoked rather than unknown, and not
 * which of the checks below refused. Those distinctions are exactly what would
 * turn this route into an oracle over the application registry, and the caller
 * can do nothing with any of them — the answer for every ineligible caller is
 * the same. The detail goes to the log, where the operator can read it and the
 * caller cannot.
 */
const refuseNotPublic = (res: Response, reason: string, context: Record<string, unknown>) => {
  logger.warn('inference.gate.refused', { reason, ...context });
  res.status(403).json({
    error: 'ENDPOINT_NOT_PUBLIC',
    message: 'This endpoint is not publicly available.',
  });
};

/**
 * INTERIM GATE (issue #981) — restrict generic chat inference to callers acting
 * for a platform-trusted (first-party / internal / official) application.
 *
 * ## What this replaces, and what replaces IT
 *
 * `POST /chat/completions` forwards the caller's body verbatim to one shared
 * upstream key (`ALIA_API_KEY`). Behind `authMiddleware` alone, every signed-in
 * Oxy user could spend Oxy's upstream budget with no reservation, no metering,
 * no attribution and no per-caller stop — `max_tokens` and the prompt are the
 * caller's, so a request limiter bounds the COUNT of requests and never their
 * cost.
 *
 * **This gate closes the door; it does not build the new one.** The real edge is
 * issue #972 WORKSTREAM 4: a metered public inference edge that reserves spend
 * against the ledger (workstream 7 / ADR 0009) BEFORE a request enters the data
 * plane, and retires the single static upstream key. Do not delete this gate
 * without that edge in place — deleting it restores the exposure verbatim.
 *
 * ## The rule
 *
 * The caller must present a SERVICE token, and the credential that minted it
 * must still resolve, through the registry, to an ACTIVE, platform-trusted
 * application. The resolution runs in the one direction ADR 0007 fixes
 * (`docs/adr/0007-canonical-request-attribution.md`): presented credential →
 * `application_credentials` row → `application_id` → `applications` row. The
 * token's own `appId` claim is NOT the authority for that hop; the credential
 * row is.
 *
 * Trust is `isTrustedApplication()` — the same staff-controlled predicate the
 * CORS registry, OAuth consent auto-approve and the service-token mint read.
 * `status: 'active'` alone is never a trust boundary, so an active third-party
 * application is refused.
 *
 * Every check is re-read per request rather than trusted from the token. A
 * service token lives an hour; a credential can be revoked and an application
 * can be flipped out of trusted status inside that hour, and both must lock the
 * caller out immediately.
 *
 * ## A USER SESSION BEARER NO LONGER REACHES THIS ROUTE — deliberately
 *
 * A user access token names a user, not an application. `sessions.application_id`
 * is NULL for every shared device session (which is what every official app
 * uses) and is set ONLY for an untrusted third-party OAuth client's isolated
 * session — so from a user bearer, "an application resolves" and "the
 * application is trusted" are mutually exclusive, and no user bearer can satisfy
 * both. Rather than invent a second trust concept for that case, the route takes
 * the ADR 0007 answer: a request whose responsible application cannot be
 * resolved from a presented credential is refused, with no fallback to the
 * signed-in user's personal account. Named callers that lose access are listed
 * in the PR for #981; the Console playground is the one in this repository.
 *
 * ## Fails closed
 *
 * There is no path through this function that calls `next()` without an active,
 * trusted application resolved from a usable credential. An absent bearer, an
 * unverifiable one, a non-service one, an unknown or unusable credential, a
 * missing/inactive application and an untrusted application all refuse.
 */
const requireFirstPartyInferenceCaller = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    const token = extractTokenFromRequest(req);
    if (!token) {
      res.status(401).json({
        error: 'Authentication required',
        message: 'Invalid or missing authorization header',
      });
      return;
    }

    const verification = verifyServiceToken(token);
    if (!verification.ok) {
      // `expired` / `invalid` are ordinary authentication failures and keep the
      // 401 an unauthenticated caller has always received here. `not_service`
      // is a VALID Oxy credential that simply names no application — a user
      // session bearer — so it is an authorization answer, not a login prompt.
      if (verification.reason !== 'not_service') {
        res.status(401).json({
          error: 'Invalid token',
          message: 'The provided authentication token is invalid',
        });
        return;
      }
      refuseNotPublic(res, 'not_a_service_token', { path: req.path });
      return;
    }

    const { credentialId, appId } = verification.payload;

    const [row] = await getDb()
      .select({
        credentialStatus: applicationCredentials.status,
        credentialExpiresAt: applicationCredentials.expiresAt,
        applicationId: applications.id,
        applicationStatus: applications.status,
        type: applications.type,
        isOfficial: applications.isOfficial,
        isInternal: applications.isInternal,
      })
      .from(applicationCredentials)
      .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
      .where(eq(applicationCredentials.id, credentialId))
      .limit(1);

    if (!row) {
      refuseNotPublic(res, 'unresolvable_credential', { credentialId, claimedAppId: appId });
      return;
    }

    if (
      !isCredentialUsable({ status: row.credentialStatus, expiresAt: row.credentialExpiresAt })
    ) {
      refuseNotPublic(res, 'unusable_credential', {
        credentialId,
        applicationId: row.applicationId,
        credentialStatus: row.credentialStatus,
      });
      return;
    }

    if (row.applicationStatus !== 'active') {
      refuseNotPublic(res, 'inactive_application', {
        credentialId,
        applicationId: row.applicationId,
        applicationStatus: row.applicationStatus,
      });
      return;
    }

    if (
      !isTrustedApplication({
        type: row.type,
        isOfficial: row.isOfficial,
        isInternal: row.isInternal,
      })
    ) {
      refuseNotPublic(res, 'untrusted_application', {
        credentialId,
        applicationId: row.applicationId,
        applicationType: row.type,
      });
      return;
    }

    next();
  }
);

/**
 * POST /api/alia/chat/completions
 * Proxies chat completion requests to the Alia API.
 * Supports both streaming (SSE) and non-streaming responses.
 *
 * Requires a service token whose credential resolves to an active,
 * platform-trusted application (issue #981); a user session bearer is refused.
 */
router.post('/chat/completions', requireFirstPartyInferenceCaller, async (req: Request, res: Response) => {
  const apiKey = ALIA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ALIA_API_KEY not configured on server' });
    return;
  }

  const isStreaming = req.body.stream === true;

  try {
    const response = await axios.post(`${ALIA_BASE_URL}/chat/completions`, req.body, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      responseType: isStreaming ? 'stream' : 'json',
    });

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.pipe(res);
    } else {
      res.json(response.data);
    }
  } catch (err: any) {
    const status = err.response?.status ?? 502;
    const message = toSafeErrorMessage(err.response?.data);
    res.status(status).json({ error: 'ALIA_PROXY_ERROR', message });
  }
});

/**
 * The two voice routes below STILL carry only `authMiddleware`, and that is a
 * scoping decision rather than an oversight (issue #981).
 *
 * They share this file's shape — one static `ALIA_API_KEY`, a caller-supplied
 * body forwarded verbatim, no reservation and no metering — so the same class of
 * exposure exists on them. What differs is the blast radius and the cost of
 * closing it: neither offers generic chat inference (one mints a LiveKit session,
 * one transcribes an utterance), and both are reached today by signed-in users of
 * Oxy's own voice surfaces, which hold no service credential. Gating them the
 * same way would take those features away with no metered replacement to move
 * them to.
 *
 * They are named in the PR for #981 and belong to the same replacement: the
 * metered public edge of #972 workstream 4.
 */
/** POST /v1/voice/token — LiveKit session mint for Alia voice (inbox, etc.). */
router.post('/voice/token', authMiddleware, (req, res) => proxyAliaJson(req, res, '/voice/token'));

/** POST /v1/voice/transcribe — speech-to-text for Alia chat input. */
router.post('/voice/transcribe', authMiddleware, (req, res) =>
  proxyAliaJson(req, res, '/voice/transcribe'),
);

export default router;
