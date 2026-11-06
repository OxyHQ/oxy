import { z } from 'zod';

// biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly refuse controls in postal fields.
const forbidden = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

// Postal details are private account data, never part of a public profile.
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !forbidden.test(value), 'Control characters are not allowed');
export const postalAddressParamsSchema = z.object({ id: z.uuid() }).strict();
export const postalAddressInputSchema = z
  .object({
    recipientName: text(200),
    line1: text(300),
    line2: text(300).optional(),
    city: text(150),
    region: text(150).optional(),
    postalCode: z
      .string()
      .trim()
      .max(32)
      .refine((value) => !forbidden.test(value)),
    country: z.string().regex(/^[A-Z]{2}$/),
    phone: text(50).optional(),
    label: text(100).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();
export const postalAddressUpdateSchema = postalAddressInputSchema
  .partial()
  .extend({
    line2: text(300).nullable().optional(),
    region: text(150).nullable().optional(),
    phone: text(50).nullable().optional(),
    label: text(100).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field');
export const postalAddressSchema = postalAddressInputSchema.extend({
  id: z.string().min(1),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PostalAddressInput = z.infer<typeof postalAddressInputSchema>;
export type PostalAddressUpdate = z.infer<typeof postalAddressUpdateSchema>;
export type PostalAddress = z.infer<typeof postalAddressSchema>;
