import {
  billingCustomerLocationRequestSchema,
  billingCustomerLocationResultSchema,
  isoDateTime,
  utf16MaxLength,
  utf16MinLength,
  type BillingCustomerLocationRequest,
} from '@oxy.so/contracts';
import type { Peable } from '@peable.to/sdk';
import { z } from 'zod';
import { ApiError } from '../utils/error';
import { assertPeableBillingMerchant } from './peableBillingWorkload.service';

type Client = Pick<Peable, 'merchants' | 'tax'>;
type Configuration = {
  merchantId: string;
  applicationId: string;
  namespace: { mode: 'live' | 'test'; environment: string };
};
const evidenceSchema = z.object({
  id: z
    .string()
    .regex(/^taxloc_[A-Za-z0-9_]+$/)
    .check(utf16MaxLength(160)),
  customerRef: z.string().check(utf16MinLength(1)).check(utf16MaxLength(128)),
  status: z.enum(['sufficient', 'insufficient', 'conflicting']),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  livemode: z.boolean(),
  observedAt: z.string().check(isoDateTime()),
  expiresAt: z.string().check(isoDateTime()),
});
function verifyEvidence(raw: unknown, subject: string, configuration: Configuration, now: Date) {
  const parsed = evidenceSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.customerRef !== subject ||
    parsed.data.livemode !== (configuration.namespace.mode === 'live') ||
    Date.parse(parsed.data.observedAt) > now.getTime()
  )
    throw new ApiError(
      403,
      'Payer location evidence is unavailable',
      'BILLING_LOCATION_UNAVAILABLE',
    );
  if (
    Date.parse(parsed.data.expiresAt) <= now.getTime() ||
    Date.parse(parsed.data.expiresAt) <= Date.parse(parsed.data.observedAt)
  )
    throw new ApiError(409, 'Payer location evidence expired', 'BILLING_LOCATION_EXPIRED');
  return parsed.data;
}

/** No Oxy address store or request logging. Peable owns the bounded evidence. */
export async function recordPeableCustomerLocation(
  client: Client,
  configuration: Configuration,
  subject: string,
  raw: BillingCustomerLocationRequest,
  clock: () => Date = () => new Date(),
) {
  const input = billingCustomerLocationRequestSchema.parse(raw);
  if (subject !== input.expectedSubjectAccountId)
    throw new ApiError(403, 'Signed-in subject changed', 'SUBJECT_CHANGED');
  await assertPeableBillingMerchant(client, configuration);
  const recorded = verifyEvidence(
    await client.tax.locationEvidence.create({
      customerRef: subject,
      evidence: [{ type: 'billing_address', address: input.billingAddress }],
    }),
    subject,
    configuration,
    clock(),
  );
  if (recorded.country !== null && recorded.country !== input.billingAddress.country)
    throw new ApiError(403, 'Payer location evidence differs', 'BILLING_LOCATION_UNAVAILABLE');
  return billingCustomerLocationResultSchema.parse({
    state: 'recorded',
    subjectAccountId: subject,
    evidenceId: recorded.id,
    status: recorded.status,
    country: recorded.country,
    expiresAt: recorded.expiresAt,
  });
}

/** A caller supplies only a reference: ownership and sufficiency come from Peable. */
export async function resolvePeableCustomerLocation(
  client: Client,
  configuration: Configuration,
  subject: string,
  evidenceId: string | undefined,
  clock: () => Date = () => new Date(),
) {
  if (!evidenceId)
    throw new ApiError(422, 'Billing location evidence is required', 'BILLING_LOCATION_REQUIRED');
  await assertPeableBillingMerchant(client, configuration);
  const evidence = verifyEvidence(
    await client.tax.locationEvidence.retrieve(evidenceId),
    subject,
    configuration,
    clock(),
  );
  if (evidence.id !== evidenceId)
    throw new ApiError(403, 'Payer location evidence differs', 'BILLING_LOCATION_UNAVAILABLE');
  if (evidence.status !== 'sufficient' || !evidence.country)
    throw new ApiError(
      422,
      'More verified location evidence is required',
      'BILLING_LOCATION_INSUFFICIENT',
    );
  return { customerLocationEvidenceId: evidence.id };
}
