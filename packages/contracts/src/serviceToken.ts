import { z } from 'zod';

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

/** First-party authority is issued only to an attested, live Oxy workload. */
export const serviceAuthoritySchema = z.enum(['first_party', 'external']);
export type ServiceAuthority = z.infer<typeof serviceAuthoritySchema>;

const resourceIdentity = {
  active: z.literal(true),
  accountId: z.string().min(1),
  applicationId: z.string().min(1),
  credentialId: z.string().min(1),
  environment: z.enum(['production', 'staging', 'development']),
  audience: z.string().min(1),
  expiresAt: z.string().datetime(),
};

/** No scope list exists in the internal authority variant. */
export const firstPartyServicePrincipalSchema = z.object({
  ...resourceIdentity,
  authority: z.literal('first_party'),
  scopes: z.never().optional(),
});
export const externalServicePrincipalSchema = z.object({
  ...resourceIdentity,
  authority: z.literal('external'),
  scopes: z.array(z.string().min(1)),
});
export const servicePrincipalSchema = z.discriminatedUnion('authority', [
  firstPartyServicePrincipalSchema,
  externalServicePrincipalSchema,
]);
export const serviceIntrospectionSchema = z.union([
  z.object({ active: z.literal(false) }),
  servicePrincipalSchema,
]);
export type FirstPartyServicePrincipal = z.infer<typeof firstPartyServicePrincipalSchema>;
export type ServicePrincipal = z.infer<typeof servicePrincipalSchema>;
export type ServiceIntrospection = z.infer<typeof serviceIntrospectionSchema>;

/** A resource receiver introspects services, external keys and human sessions distinctly. */
const sessionIdentity = {
  active: z.literal(true),
  kind: z.literal('session'),
  permissions: z.array(z.string()),
  accountId: z.string().min(1),
  requesterAccountId: z.string().min(1),
  effectiveAccountId: z.string().min(1),
  expiresAt: z.string().datetime(),
};
export const resourcePrincipalSchema = z.union([
  firstPartyServicePrincipalSchema.extend({
    kind: z.literal('service'),
    permissions: z.array(z.string()),
  }),
  externalServicePrincipalSchema.extend({
    kind: z.literal('service'),
    permissions: z.array(z.string()),
  }),
  z.object({
    active: z.literal(true),
    kind: z.literal('key'),
    expiresAt: z.string().datetime().optional(),
    permissions: z.array(z.string()),
    authority: z.literal('external'),
    accountId: z.string().min(1),
    applicationId: z.string().min(1),
    credentialId: z.string().min(1),
    environment: z.enum(['production', 'staging', 'development']),
    scopes: z.array(z.string().min(1)),
  }),
  z.object({
    ...sessionIdentity,
    authority: z.literal('first_party'),
    applicationId: z.null(),
    scopes: z.never().optional(),
  }),
  z.object({
    ...sessionIdentity,
    authority: z.literal('external'),
    applicationId: z.string().min(1),
    scopes: z.array(z.string().min(1)),
  }),
]);
export const resourceIntrospectionSchema = z.union([
  z.object({ active: z.literal(false) }),
  resourcePrincipalSchema,
]);
export type ResourcePrincipal = z.infer<typeof resourcePrincipalSchema>;
export type ResourceIntrospection = z.infer<typeof resourceIntrospectionSchema>;
