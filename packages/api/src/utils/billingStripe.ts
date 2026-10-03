/** Every provider operation is fenced by the physical billing database. */
import { assertBillingDatabaseNamespace } from '../config/billingNamespace';
import { getDb } from '../config/postgres';
import { getStripe } from './stripeClient';

export async function getBillingStripe() {
  await assertBillingDatabaseNamespace(getDb());
  return getStripe();
}
