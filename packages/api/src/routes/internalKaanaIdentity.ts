/** Kaana's private, content-free caller identity lookup. No financial writes. */
import express, { type Response } from 'express';
import { publicErrorSchema } from '@kaana.ai/contracts';
import { kaanaIdentityRequestSchema } from '@kaana.ai/contracts/internal';
import { resolveKaanaDataPlane } from '../config/kaanaDataPlane';
import { KAANA_PUBLIC_AUDIENCE } from '../config/serviceTokenAudiences';
import { requireKaanaWorkload } from '../middleware/kaanaControlWorkload';
import { authenticateInferenceBearer } from '../services/inferenceCallerIdentity.service';
import { createKaanaIdentityAssertion } from '../services/kaanaIdentity.service';

export const MAX_IDENTITY_REQUEST_BYTES = 16 * 1024;
const router = express.Router();

function refuse(
  res: Response,
  status: number,
  code: 'authentication_failed' | 'invalid_request' | 'service_unavailable',
  requestId: string,
) {
  const retryable = code === 'service_unavailable';
  res.status(status).json(
    publicErrorSchema.parse({
      schemaVersion: 1,
      code,
      requestId,
      retryable,
      message: retryable
        ? 'Identity verification is temporarily unavailable.'
        : code === 'authentication_failed'
          ? 'The credential is not valid for kaana.ai.'
          : 'The identity request is invalid.',
    }),
  );
}

router.post(
  '/identities',
  (req, res, next) => {
    requireKaanaWorkload(req, res, next, { workloadOnly: true }).catch(next);
  },
  async (req, res) => {
    let requestId = 'unknown';
    try {
      // This exact body, not reserialized JSON or inference content, is hash-bound.
      if (!Buffer.isBuffer(req.body) || req.body.length > MAX_IDENTITY_REQUEST_BYTES) {
        refuse(res, 400, 'invalid_request', requestId);
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(req.body.toString('utf8'));
      } catch {
        refuse(res, 400, 'invalid_request', requestId);
        return;
      }
      const parsed = kaanaIdentityRequestSchema.safeParse(json);
      if (!parsed.success) {
        refuse(res, 400, 'invalid_request', requestId);
        return;
      }
      requestId = parsed.data.requestId;
      const authentication = await authenticateInferenceBearer(
        parsed.data.credential,
        KAANA_PUBLIC_AUDIENCE,
      );
      if (!authentication.ok || authentication.principal.lane === 'product_session') {
        refuse(res, 401, 'authentication_failed', requestId);
        return;
      }
      const plane = resolveKaanaDataPlane();
      if (plane.status !== 'configured') {
        refuse(res, 503, 'service_unavailable', requestId);
        return;
      }
      const result = createKaanaIdentityAssertion({
        request: parsed.data,
        requestBytes: req.body,
        principal: authentication.principal,
        signing: plane.config,
      });
      for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).type('application/json').send(result.body);
    } catch {
      // Never expose a bearer, database error or schema input in logs/errors.
      refuse(res, 503, 'service_unavailable', requestId);
    }
  },
);

export default router;
