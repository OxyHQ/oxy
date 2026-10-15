/**
 * `/internal/kaana/v1` — the API Kaana calls to serve `https://kaana.ai/v1`
 * (Kaana ADR 0002, decision 3; phase 2). Deployed with no caller: nothing
 * reaches it until Kaana's public server exists (phase 3).
 *
 *   POST /authorizations   a grant (inference), a catalogue audience, or a receipt
 *   POST /settlements      one settlement from Kaana's outbox; idempotent per grant
 *
 * ## Who may call it
 *
 * Kaana alone, as a WORKLOAD (Oxy ADR 0026): a service token minted for the
 * dedicated audience `oxy-api:kaana-control`, which only the pinned Kaana
 * application may hold, re-read against its row on every call so a revoked
 * binding stops at once. An `oxy-api` token — whoever holds it — is refused.
 * It is mounted BEFORE `/internal`, whose own gate accepts only `oxy-api`.
 *
 * A settlement is ALSO signed by Kaana's own settlement key over its exact
 * bytes: the token says Kaana sent it, the signature says Kaana's outbox wrote
 * it, so neither a leaked token nor a replayed body alone can move money.
 *
 * ## The customer's credential is Kaana's to forward, Oxy's to read
 *
 * The authorization body carries the caller's `Authorization: Bearer` value
 * verbatim. It is authenticated here exactly as the old edge authenticates it
 * (`authenticateInferenceBearer`), for the `kaana.ai` audience, and the
 * machine lane's per-credential and per-application rate limits apply with the
 * SAME Redis buckets the edge uses, so a key's budget is one budget across both
 * surfaces. Refusals are the public error Kaana relays to its client.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import {
  authorizationRequestSchema,
  type AuthorizationRequest,
  settlementSchema,
} from '@kaana.ai/contracts/internal';
import { resolveKaanaDataPlane } from '../config/kaanaDataPlane';
import { resolveKaanaSettlementKeys } from '../config/kaanaSettlementKeys';
import {
  KAANA_CONTROL_APPLICATION_ID,
  KAANA_CONTROL_AUDIENCE,
  KAANA_PUBLIC_AUDIENCE,
} from '../config/serviceTokenAudiences';
import { extractTokenFromRequest } from '../middleware/authUtils';
import {
  MACHINE_APPLICATION_REQUESTS_PER_MINUTE,
  MACHINE_CREDENTIAL_REQUESTS_PER_MINUTE,
  type MachineCredentialRequest,
} from '../middleware/machineCredential';
import { rateLimit } from '../middleware/rateLimiter';
import { verifyServiceToken } from '../middleware/serviceToken';
import { resolveServiceTokenPrincipal } from '../services/attribution.service';
import { authenticateInferenceBearer, type EdgePrincipal } from '../services/inferenceEdge.service';
import { authorizeInference, publicError } from '../services/kaanaGrant.service';
import { authorizeCatalogueRead, authorizeReceiptRead } from '../services/kaanaGrantReads.service';
import {
  KAANA_KEY_ID_HEADER,
  KAANA_SIGNATURE_HEADER,
  KAANA_TIMESTAMP_HEADER,
  verifySettlementSignature,
} from '../services/kaanaGrantSigning';
import { applySettlement } from '../services/kaanaSettlement.service';
import { logger } from '../utils/logger';

const router = express.Router();

/** The largest settlement body accepted; the route's own raw parser holds it. */
export const MAX_SETTLEMENT_BYTES = 256 * 1024;

interface GrantRequest extends MachineCredentialRequest {
  grantRequest?: AuthorizationRequest;
  grantPrincipal?: EdgePrincipal;
}

/* -------------------------------------------------------------------------- */
/*  Kaana, as a workload                                                       */
/* -------------------------------------------------------------------------- */

async function requireKaanaWorkload(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractTokenFromRequest(req);
  const verification =
    token === null || token === undefined
      ? undefined
      : verifyServiceToken(token, KAANA_CONTROL_AUDIENCE);
  if (verification === undefined || !verification.ok) {
    res.status(401).json({ error: 'kaana_workload_required' });
    return;
  }
  if (verification.payload.appId !== KAANA_CONTROL_APPLICATION_ID) {
    logger.warn('inference.kaana_control.foreign_application', {
      applicationId: verification.payload.appId,
    });
    res.status(403).json({ error: 'kaana_workload_required' });
    return;
  }
  // The row, not the token: a revoked credential or binding stops within the hour it was minted for.
  const resolution = await resolveServiceTokenPrincipal(verification.payload);
  if (resolution.status !== 'resolved') {
    logger.warn('inference.kaana_control.principal_unresolved', { status: resolution.status });
    res.status(403).json({ error: 'kaana_workload_required' });
    return;
  }
  // The application comes from the ROW the token names, never from its claim.
  if (resolution.principal.applicationId !== KAANA_CONTROL_APPLICATION_ID) {
    logger.warn('inference.kaana_control.foreign_application', {
      applicationId: resolution.principal.applicationId,
    });
    res.status(403).json({ error: 'kaana_workload_required' });
    return;
  }
  next();
}

router.use((req, res, next) => {
  requireKaanaWorkload(req, res, next).catch(next);
});

/* -------------------------------------------------------------------------- */
/*  POST /authorizations                                                       */
/* -------------------------------------------------------------------------- */

const AUTHENTICATION_MESSAGE =
  'The credential is not valid for kaana.ai. Manage keys and service tokens in Oxy Console: https://console.oxy.so';

async function parseAndAuthenticate(
  req: GrantRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const parsed = authorizationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    // Kaana's bug, not its client's: the body is Kaana's own wire shape.
    logger.warn('inference.grant.malformed_authorization', { issues: parsed.error.issues.length });
    res.status(400).json({ error: 'invalid_authorization_request' });
    return;
  }
  const request = parsed.data;
  const authentication = await authenticateInferenceBearer(
    request.credential,
    KAANA_PUBLIC_AUDIENCE,
  );
  if (!authentication.ok) {
    logger.warn('inference.grant.authentication_failed', {
      requestId: request.requestId,
      kind: request.kind,
      reason: authentication.reason,
    });
    res
      .status(401)
      .json(publicError(request.requestId, 'authentication_failed', AUTHENTICATION_MESSAGE));
    return;
  }
  req.grantRequest = request;
  req.grantPrincipal = authentication.principal;
  if (authentication.machinePrincipal !== undefined)
    req.machineCredential = authentication.machinePrincipal;
  next();
}

/** The edge's machine limits, on the edge's own Redis buckets, answered as a public error. */
function machineLimit(prefix: string, max: number, key: (principal: EdgePrincipal) => string) {
  return rateLimit({
    prefix,
    windowMs: 60_000,
    max,
    keyGenerator: (req) => {
      const principal = (req as GrantRequest).grantPrincipal;
      return principal === undefined ? '' : key(principal);
    },
    // Only the machine lane carries these limits, as on the edge.
    skip: (req) => (req as GrantRequest).machineCredential === undefined,
    handler: (req, res) => {
      const grantRequest = (req as GrantRequest).grantRequest;
      const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit
        ?.resetTime;
      const retryAfterMs =
        resetTime === undefined ? undefined : Math.max(0, resetTime.getTime() - Date.now());
      res
        .status(429)
        .json(
          publicError(
            grantRequest?.requestId ?? 'unknown',
            'rate_limited',
            'This API key or application is over its request limit. Slow down and retry.',
            undefined,
            retryAfterMs,
          ),
        );
    },
  });
}

const grantCredentialLimiter = machineLimit(
  'rl:machine:credential:',
  MACHINE_CREDENTIAL_REQUESTS_PER_MINUTE,
  (principal) => principal.credentialId,
);
const grantApplicationLimiter = machineLimit(
  'rl:machine:application:',
  MACHINE_APPLICATION_REQUESTS_PER_MINUTE,
  (principal) => principal.applicationId,
);

router.post(
  '/authorizations',
  (req, res, next) => {
    parseAndAuthenticate(req as GrantRequest, res, next).catch(next);
  },
  grantCredentialLimiter,
  grantApplicationLimiter,
  (req, res, next) => {
    respondToAuthorization(req as GrantRequest, res).catch(next);
  },
);

async function respondToAuthorization(req: GrantRequest, res: Response): Promise<void> {
  const request = req.grantRequest;
  const principal = req.grantPrincipal;
  if (request === undefined || principal === undefined) {
    res.status(500).json({ error: 'internal_error' });
    return;
  }
  switch (request.kind) {
    case 'inference': {
      const plane = resolveKaanaDataPlane();
      const decision = await authorizeInference({
        request,
        principal,
        signing: plane.status === 'configured' ? plane.config : undefined,
      });
      if (decision.status === 'refused') {
        res.status(decision.httpStatus).json(decision.error);
        return;
      }
      for (const [name, value] of Object.entries(decision.headers)) res.setHeader(name, value);
      res.status(200).type('application/json').send(decision.body);
      return;
    }
    case 'catalogue.read':
      res.status(200).json(await authorizeCatalogueRead(request, principal));
      return;
    case 'receipt.read': {
      const decision = await authorizeReceiptRead(request, principal);
      if (decision.status === 'not-found') {
        res
          .status(404)
          .json(
            publicError(
              request.requestId,
              'model_not_found',
              'No generation record is available to you.',
            ),
          );
        return;
      }
      res.status(200).json(decision.access);
      return;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  POST /settlements                                                          */
/* -------------------------------------------------------------------------- */

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

router.post('/settlements', (req, res, next) => {
  respondToSettlement(req, res).catch(next);
});

async function respondToSettlement(req: Request, res: Response): Promise<void> {
  const keys = resolveKaanaSettlementKeys();
  if (keys.status !== 'configured') {
    res.status(503).json({ error: 'settlement_keys_not_configured' });
    return;
  }
  if (!Buffer.isBuffer(req.body)) {
    res.status(415).json({ error: 'settlement_body_must_be_json' });
    return;
  }
  const body = req.body;
  const check = verifySettlementSignature(
    {
      keyId: header(req, KAANA_KEY_ID_HEADER),
      timestamp: header(req, KAANA_TIMESTAMP_HEADER),
      signature: header(req, KAANA_SIGNATURE_HEADER),
    },
    body,
    keys.keys,
    Date.now(),
  );
  if (!check.ok) {
    logger.warn('inference.settlement.signature_refused', { reason: check.reason });
    res.status(401).json({ error: 'settlement_signature_invalid' });
    return;
  }
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'invalid_settlement' });
    return;
  }
  const parsed = settlementSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn('inference.settlement.malformed', { issues: parsed.error.issues.length });
    res.status(400).json({ error: 'invalid_settlement' });
    return;
  }
  const result = await applySettlement(parsed.data, 'delivery');
  if (result.status === 'rejected') {
    // Permanent: Kaana's outbox must stop redelivering it and surface it.
    res.status(422).json({ error: result.reason });
    return;
  }
  res.status(200).json(result.acknowledgement);
}

export default router;
