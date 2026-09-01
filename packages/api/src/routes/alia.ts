import { Router, type Request, type Response, type NextFunction } from 'express';
import axios from 'axios';
import { safeErrorTextSchema } from '@oxyhq/contracts';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
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

/**
 * The upstream's own error text when it is safe to relay, and the generic
 * message when it is not.
 *
 * ## What this replaces
 *
 * `toSafeErrorMessage` returned its argument unchanged for everything except
 * `null`/`undefined`, a stream, and an object that would not serialise — so
 * every string and every serialisable object reached the caller verbatim. It was
 * a serialisability check wearing a redaction's name, and the name was the
 * dangerous half: a reader sees `toSafeErrorMessage` and stops looking.
 *
 * Every route in this file calls ONE upstream with ONE shared platform
 * credential (`ALIA_API_KEY`). An OpenAI-family error body is
 * `{"error":{"message":"Incorrect API key provided: sk-…"}}`, so a verbatim
 * relay hands Oxy's own upstream key to whoever provoked the error.
 *
 * ## The rule
 *
 * The whole upstream body is reduced to one string, that string is offered to
 * `safeErrorTextSchema` — the SAME last-resort refusal the metered `/v1` edge
 * applies through `utils/inferenceEdgeErrors.ts` — and a refused string is
 * REPLACED, never edited. Three consequences, each of which is the reason for a
 * line below rather than a preference:
 *
 *  - The check reads the WHOLE body, not a `message` field picked out of it, so
 *    a credential echoed into a field nobody thought to read is still refused.
 *  - Nothing is truncated before the check. Truncating first can cut a marker
 *    away from the value it marks and so turn a refusal into an accept, which is
 *    why a body the schema will not look at (over its 2000-character bound) is
 *    not relayed at all rather than shortened until it fits.
 *  - A refused body is replaced WHOLE. Replacing only the matched span would
 *    leave the credential and remove the evidence — measured in OxyHQ/Kaana#3
 *    and written up on `safeErrorTextSchema` itself.
 *
 * A benign upstream error still reaches the caller with its text intact:
 * blanking every error would trade a bounded leak for first-party clients that
 * can never be debugged.
 *
 * ## This is a refusal, not the control
 *
 * Issue #1027's rule applies here too — the reliable control is redacting the
 * credential where the bytes are still held, which for this proxy is Alia's own
 * error writer, on the other side of an HTTP boundary Oxy does not own. That is
 * precisely why the refusal sits here, and why it is the last line rather than
 * the only one: retiring these routes for the metered edge (#972 workstream 14 /
 * ADR 0010) is what removes the shared key they leak.
 */
const relayableUpstreamMessage = (data: unknown, status: number): string => {
  if (data === undefined || data === null || isReadableStream(data)) {
    return ALIA_PROXY_ERROR_MESSAGE;
  }

  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else if (typeof data === 'object') {
    try {
      text = JSON.stringify(data);
    } catch {
      return ALIA_PROXY_ERROR_MESSAGE;
    }
  } else {
    // A number or a boolean body carries no upstream detail to relay, and
    // rendering one as text would only put a bare `0` in front of a caller.
    return ALIA_PROXY_ERROR_MESSAGE;
  }

  if (text.length === 0) {
    return ALIA_PROXY_ERROR_MESSAGE;
  }

  if (!safeErrorTextSchema.safeParse(text).success) {
    // The status and the length, never the text: writing the string that was
    // refused FOR carrying a credential into the log is the leak moving house.
    logger.warn('alia.proxy.upstream_message_withheld', { status, messageLength: text.length });
    return ALIA_PROXY_ERROR_MESSAGE;
  }

  return text;
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
    const message = relayableUpstreamMessage(err.response?.data, status);
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
    const message = relayableUpstreamMessage(err.response?.data, status);
    res.status(status).json({ error: 'ALIA_PROXY_ERROR', message });
  }
});

/**
 * The two voice routes below now carry the SAME gate as `/chat/completions`
 * (#972 workstream 2.3, closing the exemption #981 left open).
 *
 * ## Why they were exempt, and why that reason turned out to be false
 *
 * #981 gated chat and deliberately left these two behind, on the stated grounds
 * that "both are reached today by signed-in users of Oxy's own voice surfaces,
 * which hold no service credential" — so gating them would remove a working
 * feature with no metered replacement to move it to. That was the right trade to
 * make on the information available, and the information was wrong.
 *
 * A read-only census across every repository under `~/Oxy` found **no caller of
 * these two routes anywhere**, and in particular not the voice surface the old
 * comment on `/voice/token` named:
 *
 * - Inbox's voice feature is `VoiceSession` from `@alia.onl/sdk`, and the
 *   INSTALLED package (5.1.0, not the sibling source tree) builds
 *   `/v1/voice/token` and `/v1/voice/transcribe` against `https://api.alia.onl`.
 *   It names no Oxy host at all, so it never traverses this proxy. Inbox's only
 *   Oxy-routed Alia call is `/alia/chat/completions`.
 * - Alia's own `alia-chat` hooks and `integrations` client target
 *   `EXPO_PUBLIC_ALIA_API_URL ?? 'https://api.alia.onl'` and Alia's own API port
 *   respectively — Alia has its OWN `/v1/voice/*` routes, which is what those
 *   call.
 * - No `@oxyhq/services` / `@oxyhq/core` surface exposes a voice method, and no
 *   INSTALLED copy of either in fourteen consumer repositories references the
 *   paths.
 * - Mention's LiveKit usage is its own rooms feature against `livekit.oxy.so`,
 *   minted by its own backend.
 *
 * So the exemption was protecting nothing, while leaving the exposure open: one
 * static `ALIA_API_KEY`, a caller-supplied body forwarded verbatim, `max_tokens`
 * and the audio the caller's to choose, and no reservation or metering — which
 * means a request limiter bounds the COUNT of requests and never their cost, and
 * the cost lands on one shared Oxy budget with no per-account attribution.
 *
 * ## What this does NOT change
 *
 * These are still Alia PRODUCT endpoints on a shared key, not part of the metered
 * edge. Retiring them is #972 workstream 14 / ADR 0010. Gating closes the door;
 * it does not build the new one — the same thing #981 said about chat.
 */
/** POST /v1/voice/token — LiveKit session mint for Alia voice. */
router.post('/voice/token', requireFirstPartyInferenceCaller, (req, res) =>
  proxyAliaJson(req, res, '/voice/token'),
);

/** POST /v1/voice/transcribe — speech-to-text for Alia chat input. */
router.post('/voice/transcribe', requireFirstPartyInferenceCaller, (req, res) =>
  proxyAliaJson(req, res, '/voice/transcribe'),
);

export default router;
