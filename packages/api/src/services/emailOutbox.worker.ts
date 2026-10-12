import { randomUUID } from 'node:crypto';
import { deliverClaimed } from './emailDelivery.service';
import { claimEmailOutbox } from './emailOutbox.service';

const workerId = `email-outbox-${randomUUID()}`;

/**
 * Retry what failed transiently, and adopt a claim whose task died before it
 * delivered. A send is normally delivered by the request that accepted it
 * (`emailDelivery.service.ts`); this is everything after its first attempt.
 * At-least-once claiming plus a stable RFC Message-ID makes a retried SMTP
 * submission observable and idempotent.
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
