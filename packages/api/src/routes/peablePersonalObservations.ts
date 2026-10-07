import { Router } from 'express';
import { z } from 'zod';
import { getPeablePersonalRuntime } from '../services/peablePersonalRuntime.service';

const router = Router();
router.post('/:sourceId', async (req, res) => {
  const runtime = getPeablePersonalRuntime();
  if (!runtime?.configuration.observationsEnabled) return res.status(503).json({ error: 'PEABLE_OBSERVATIONS_DISABLED' });
  const sourceId = z.string().uuid().safeParse(req.params.sourceId);
  const signature = req.get('peable-signature');
  if (!sourceId.success || !signature || !Buffer.isBuffer(req.body) || req.body.length > 1_048_576)
    return res.status(400).json({ error: 'INVALID_PEABLE_OBSERVATION' });
  try {
    await runtime.observe(sourceId.data, req.body.toString('utf8'), signature);
    return res.status(200).json({ received: true });
  } catch {
    // Any read/reconciliation failure leaves delivery unacknowledged so Peable
    // can retry. Neither signed delivery fields nor response bodies grant access.
    return res.status(503).json({ error: 'PEABLE_OBSERVATION_DEFERRED' });
  }
});
export default router;
