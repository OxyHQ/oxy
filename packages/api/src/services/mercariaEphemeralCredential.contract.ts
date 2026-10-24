import { isoDateTime, utf16MinLength } from '@oxy.so/contracts';
import { z } from '@oxy.so/zod4';
export const target = {
  applicationId: '6a37d0cc5d4b5f15482a9340',
  ownerAccountId: '69b2d3df5d12f58c9800d651',
};
export const planSchema = z
  .object({
    kind: z.literal('mercaria-ephemeral-service-v1'),
    target: z
      .object({
        applicationId: z.literal(target.applicationId),
        ownerAccountId: z.literal(target.ownerAccountId),
      })
      .strict(),
    credentialId: z.string().guid(),
    nonce: z.string().regex(/^[a-f0-9]{24}$/),
    issuedAt: z.string().check(isoDateTime()),
    expiresAt: z.string().check(isoDateTime()),
    before: z
      .object({
        version: z.string().regex(/^\d+$/),
        updatedAt: z.string().check(utf16MinLength(1)),
        scopes: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export const stateSchema = z
  .object({
    version: z.string().regex(/^\d+$/),
    updatedAt: z.string().check(utf16MinLength(1)),
    status: z.literal('active'),
  })
  .strict();
export const inspectSchema = z
  .object({
    plan: planSchema,
    actor: z.string().check(utf16MinLength(1)),
    operation: z.literal('inspect'),
    state: stateSchema,
  })
  .strict();
export const materialSchema = z
  .object({
    publicKey: z.string().regex(/^oxy_dk_[a-f0-9]{48}$/),
    secret: z.string().regex(/^[a-f0-9]{64}$/),
    secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const verifierSchema = materialSchema.omit({ secret: true }).strict();
