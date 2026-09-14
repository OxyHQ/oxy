import { z } from 'zod';
import { userResponseSchema } from './userResponse';

export const externalIdentityReferenceSchema = z.object({
  canonicalAcct: z.string().min(1),
  network: z.string().min(1),
  protocol: z.enum(['activitypub', 'atproto']),
  actorUri: z.string().min(1),
  transportAcct: z.string().min(1),
  sourceUserId: z.string().min(1),
});

export const resolveExternalIdentityRequestSchema = z.object({
  actorUri: z.string().min(1).max(2048).optional(),
  handle: z.string().min(1).max(2048).optional(),
  transportAcct: z.string().max(320).optional(),
  protocol: z.enum(['activitypub', 'atproto']).optional(),
}).refine(value => Boolean(value.actorUri) !== Boolean(value.handle), 'Exactly one actorUri or handle is required');

export const resolveExternalIdentityResponseSchema = z.object({
  user: userResponseSchema.extend({
    id: z.string().min(1),
    username: z.string().min(1),
    bio: z.string().optional(),
    externalIdentities: z.array(externalIdentityReferenceSchema),
    redirectedUserIds: z.array(z.string()),
  }),
  externalIdentity: externalIdentityReferenceSchema.extend({ userId: z.string() }),
  externalIdentities: z.array(externalIdentityReferenceSchema),
  redirectedUserIds: z.array(z.string()),
}).superRefine((value, context) => {
  if (value.externalIdentity.userId !== value.user.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['externalIdentity', 'userId'], message: 'Canonical user id does not match profile' });
  }
  if (!value.externalIdentities.some(identity => identity.actorUri === value.externalIdentity.actorUri
    && identity.canonicalAcct === value.externalIdentity.canonicalAcct
    && identity.sourceUserId === value.externalIdentity.sourceUserId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['externalIdentity'], message: 'Resolved source is absent from authoritative identities' });
  }
  if (!value.externalIdentities.some(identity => identity.canonicalAcct === value.user.username)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['user', 'username'], message: 'Profile handle is not an authoritative identity' });
  }
});

export const lookupExternalIdentitiesRequestSchema = z.object({ identifiers: z.array(z.string().min(1).max(2048)).min(1).max(100) });
export const lookupExternalIdentitiesResponseSchema = z.object({
  identities: z.array(z.object({
    identifier: z.string(),
    userId: z.string().nullable(),
    externalIdentities: z.array(externalIdentityReferenceSchema),
    redirectedUserIds: z.array(z.string()),
  })),
});

export type ExternalIdentityReference = z.infer<typeof externalIdentityReferenceSchema>;
export type ResolveExternalIdentityRequest = z.infer<typeof resolveExternalIdentityRequestSchema>;
export type ResolveExternalIdentityResponse = z.infer<typeof resolveExternalIdentityResponseSchema>;
export type LookupExternalIdentitiesResponse = z.infer<typeof lookupExternalIdentitiesResponseSchema>;
