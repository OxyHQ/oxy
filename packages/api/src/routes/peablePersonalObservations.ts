import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPeablePersonalRuntime } from '../services/peablePersonalRuntime.service';
import { assertPeablePersonalReconciliationComplete } from '../services/peablePersonalEvidence.service';

const router = Router();
export async function receivePeablePersonalObservation(req: Request, res: Response) {
  const runtime = getPeablePersonalRuntime();
  if (!runtime?.configuration.observationsEnabled) return res.status(503).json({ error: 'PEABLE_OBSERVATIONS_DISABLED' });
  const rawSourceId: unknown = req.params.sourceId;
  if (typeof rawSourceId !== 'string')
    return res.status(400).json({ error: 'INVALID_PEABLE_OBSERVATION' });
  const sourceId = z.string().uuid().safeParse(rawSourceId);
  const signature = req.get('peable-signature');
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !Buffer.isBuffer(body))
    return res.status(400).json({ error: 'INVALID_PEABLE_OBSERVATION' });
  if (!sourceId.success || typeof signature !== 'string' || signature.length === 0 || body.length > 1_048_576)
    return res.status(400).json({ error: 'INVALID_PEABLE_OBSERVATION' });
  try {
    const result = await runtime.observe(sourceId.data, body.toString('utf8'), signature);
    assertPeablePersonalReconciliationComplete(result);
    return res.status(200).json({ received: true });
  } catch {
    // Any read/reconciliation failure leaves delivery unacknowledged so Peable
    // can retry. Neither signed delivery fields nor response bodies grant access.
    return res.status(503).json({ error: 'PEABLE_OBSERVATION_DEFERRED' });
  }
}
router.post('/:sourceId', receivePeablePersonalObservation);
export default router;
