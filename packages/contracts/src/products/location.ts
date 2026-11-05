import { z } from 'zod';
import { isoDateTime, utf16MaxLength, utf16MinLength } from '../stringChecks';
import { oxyAccountIdSchema } from '../inference/identifiers';

const boundedText = (maximum: number) =>
  z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(maximum));
/** Payer-declared billing address only; never client assertions of bank/card/IP evidence. */
export const billingCustomerAddressSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/),
    state: z
      .string()
      .regex(/^[A-Z0-9]{1,3}$/)
      .optional(),
    postalCode: boundedText(20).optional(),
    city: boundedText(200).optional(),
    line1: boundedText(200).optional(),
    line2: boundedText(200).optional(),
  })
  .strict();
export const billingCustomerLocationRequestSchema = z
  .object({
    expectedSubjectAccountId: oxyAccountIdSchema,
    billingAddress: billingCustomerAddressSchema,
  })
  .strict();
export const billingCustomerLocationResultSchema = z.discriminatedUnion('state', [
  z
    .object({ state: z.literal('unconfigured'), reason: z.literal('provider_unconfigured') })
    .strict(),
  z
    .object({
      state: z.literal('recorded'),
      subjectAccountId: oxyAccountIdSchema,
      evidenceId: z
        .string()
        .regex(/^taxloc_[A-Za-z0-9_]+$/)
        .check(utf16MaxLength(160)),
      status: z.enum(['sufficient', 'insufficient', 'conflicting']),
      country: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .nullable(),
      expiresAt: z.string().check(isoDateTime()),
    })
    .strict(),
]);
export type BillingCustomerAddress = z.infer<typeof billingCustomerAddressSchema>;
export type BillingCustomerLocationRequest = z.infer<typeof billingCustomerLocationRequestSchema>;
export type BillingCustomerLocationResult = z.infer<typeof billingCustomerLocationResultSchema>;
