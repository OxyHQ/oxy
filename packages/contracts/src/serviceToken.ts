import { z } from '@oxy.so/zod3';

/** Omitted means the existing grant; an explicit set only narrows that authority. */
export const serviceTokenScopesSchema = z
  .array(z.string().trim().min(1).max(128))
  .min(1)
  .max(100)
  .refine((scopes) => new Set(scopes).size === scopes.length, 'Requested scopes must be unique')
  .transform((scopes) => [...scopes].sort());
export const serviceTokenOptionsSchema = z
  .object({ scopes: serviceTokenScopesSchema.optional() })
  .strict();
export type ServiceTokenOptions = z.input<typeof serviceTokenOptionsSchema>;
