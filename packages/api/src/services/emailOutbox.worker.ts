import { randomUUID } from 'node:crypto';
import { claimEmailOutbox } from './emailOutbox.service';
import { deliverClaimed } from './emailDelivery.service';

const workerId = `email-outbox-sweep-${randomUUID()}`;

/**
 * The safety net under `emailDelivery.queue.ts`: every minute, deliver what is
 * due and nobody is working on — a retry whose queue job was lost, a job whose
 * worker died mid-send (its lease expired), a send accepted while Redis was
 * down. Delivery itself, and the recording of its outcome, is the same code the
 * queue runs; this only decides which rows to hand it.
 */
export async function processEmailOutbox(): Promise<number> {
  let processed = 0;
  while (processed < 25) {
    const row = await claimEmailOutbox(workerId);
    if (!row) break;
    await deliverClaimed(row);
    processed++;
  }
  return processed;
}
