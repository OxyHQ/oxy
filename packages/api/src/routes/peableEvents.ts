import { Router, type Request, type Response } from 'express';
import { getPeablePersonalRuntime } from '../services/peablePersonalRuntime.service';
import { assertPeablePersonalReconciliationComplete } from '../services/peablePersonalEvidence.service';

const router = Router();
/** Peable's signed webhook deliveries for Oxy's billing merchant. The body is
 * the exact signed bytes (`express.raw` is mounted before JSON parsing). */
export async function receivePeableEvent(req: Request, res: Response) {
  const runtime = getPeablePersonalRuntime();
  if (!runtime?.configuration.eventsEnabled)
    return res.status(503).json({ error: 'PEABLE_EVENTS_DISABLED' });
  const signature = req.get('peable-signature');
  const body: unknown = req.body;
  if (
    !Buffer.isBuffer(body) ||
    body.length === 0 ||
    body.length > 1_048_576 ||
    typeof signature !== 'string' ||
    signature.length === 0
  )
    return res.status(400).json({ error: 'INVALID_PEABLE_EVENT' });
  try {
    assertPeablePersonalReconciliationComplete(
      await runtime.receive(body.toString('utf8'), signature),
    );
    return res.status(200).json({ received: true });
  } catch {
    // Any verification, read or reconciliation failure leaves the delivery
    // unacknowledged so Peable retries. Delivery fields never grant access.
    return res.status(503).json({ error: 'PEABLE_EVENT_DEFERRED' });
  }
}
router.post('/', receivePeableEvent);
export default router;
