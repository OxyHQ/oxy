import { z } from '@oxy.so/zod3';
import { accountTitleSchema } from './accountName';
// The Zod-free half of this contract lives in `./client/` (`@oxy.so/contracts/client`);
// it is re-exported here so the root entry is unchanged.
import {
  ORGANIZATION_TYPES,
  ORGANIZATION_STATUSES,
  ORGANIZATION_CLAIM_STATUSES,
  ORGANIZATION_ALIAS_KINDS,
  ORGANIZATION_CLAIM_DECISIONS,
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_ERROR_CODES,
} from './client/organizations';
export {
  ORGANIZATION_TYPES,
  ORGANIZATION_STATUSES,
  ORGANIZATION_CLAIM_STATUSES,
  ORGANIZATION_ALIAS_KINDS,
  ORGANIZATION_CLAIM_DECISIONS,
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_ERROR_CODES,
} from './client/organizations';

const id = z.string().min(1).max(128);
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
export const organizationAliasSchema = z
  .object({
    alias: z.string().trim().min(1).max(300),
    kind: z.enum(ORGANIZATION_ALIAS_KINDS),
    language: z.string().min(2).max(35).optional(),
  })
  .strict();
/** An organization is named by the title policy every non-personal account uses. */
export const organizationNameSchema = accountTitleSchema;
export const createOrganizationSchema = z
  .object({
    name: organizationNameSchema,
    organizationType: z.enum(ORGANIZATION_TYPES),
    legalName: optionalText(300),
    websiteUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => /^https?:\/\//.test(value), 'Use HTTP or HTTPS')
      .nullable()
      .optional(),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .optional(),
    aliases: z.array(organizationAliasSchema).max(100).optional(),
  })
  .strict();
export const updateOrganizationSchema = createOrganizationSchema.partial();
export const organizationSchema = createOrganizationSchema
  .extend({
    accountId: id,
    username: z.string().nullable(),
    avatar: z.string().nullable(),
    legalName: z.string().nullable(),
    websiteUrl: z.string().nullable(),
    countryCode: z.string().nullable(),
    aliases: z.array(organizationAliasSchema),
    verifiedDomains: z.array(z.string()),
    claimStatus: z.enum(ORGANIZATION_CLAIM_STATUSES),
    status: z.enum(ORGANIZATION_STATUSES),
    mergedIntoAccountId: id.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const organizationSearchSchema = z
  .object({
    query: z.string().trim().max(200).default(''),
    organizationType: z.enum(ORGANIZATION_TYPES).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export const organizationListSchema = z
  .object({ items: z.array(organizationSchema), nextCursor: z.string().nullable() })
  .strict();
export const organizationBatchInputSchema = z.object({ ids: z.array(id).min(1).max(100) }).strict();
export const organizationBatchSchema = z
  .object({
    items: z.array(z.object({ requestedAccountId: id, organization: organizationSchema }).strict()),
    missingIds: z.array(id),
  })
  .strict();
export const organizationClaimInputSchema = z
  .object({
    evidenceReference: z.string().trim().min(1).max(1000),
  })
  .strict();
export const organizationClaimSchema = z
  .object({
    id,
    accountId: id,
    claimantUserId: id,
    status: z.enum(ORGANIZATION_CLAIM_DECISIONS),
    createdAt: z.string().datetime(),
  })
  .strict();
export const organizationClaimDetailSchema = organizationClaimSchema
  .extend({
    evidenceReference: z.string(),
    reviewEvidenceReference: z.string().nullable(),
    reviewedAt: z.string().datetime().nullable(),
  })
  .strict();
export const organizationClaimListQuerySchema = z
  .object({
    status: z.enum(ORGANIZATION_CLAIM_DECISIONS).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export const organizationClaimListSchema = z
  .object({ items: z.array(organizationClaimDetailSchema), nextCursor: z.string().nullable() })
  .strict();
export const organizationClaimReviewSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    evidenceReference: z.string().trim().min(1).max(1000),
  })
  .strict();
export const organizationExternalInputSchema = z
  .object({
    namespace: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    externalId: z.string().min(1).max(256),
    accountId: id.optional(),
    organization: createOrganizationSchema,
    evidenceReference: z.string().trim().min(1).max(1000),
    avatarFileId: id.optional(),
  })
  .strict();
/** Automated ingestion can create neutral identities in its granted namespace only. */
export const organizationImportBatchSchema = z
  .object({
    namespace: organizationExternalInputSchema.shape.namespace,
    items: z
      .array(
        organizationExternalInputSchema.pick({
          externalId: true,
          organization: true,
          evidenceReference: true,
          avatarFileId: true,
        }),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (input) => new Set(input.items.map((item) => item.externalId)).size === input.items.length,
    'External IDs must be unique within the batch',
  );
export const organizationImportBatchResultSchema = z
  .object({
    items: z.array(
      z.object({ externalId: z.string(), accountId: id, created: z.boolean() }).strict(),
    ),
  })
  .strict();
export type OrganizationImportBatch = z.infer<typeof organizationImportBatchSchema>;
export const organizationExternalSchema = z
  .object({ accountId: id, created: z.boolean() })
  .strict();
export const organizationExternalResolutionSchema = z.object({ accountId: id }).strict();
export const organizationMergeSchema = z
  .object({
    targetAccountId: id,
    evidenceReference: z.string().trim().min(1).max(1000),
  })
  .strict();
export const organizationErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum(ORGANIZATION_ERROR_CODES),
        message: z.string(),
        details: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional(),
      })
      .strict(),
  })
  .strict();
export type Organization = z.infer<typeof organizationSchema>;
export type OrganizationType = Organization['organizationType'];
export type CreateOrganization = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;
export type OrganizationSearch = z.input<typeof organizationSearchSchema>;
export type OrganizationList = z.infer<typeof organizationListSchema>;
export type OrganizationBatch = z.infer<typeof organizationBatchSchema>;
export type OrganizationClaim = z.infer<typeof organizationClaimSchema>;
export type OrganizationClaimInput = z.infer<typeof organizationClaimInputSchema>;
export type OrganizationClaimReview = z.infer<typeof organizationClaimReviewSchema>;
export type OrganizationExternalInput = z.infer<typeof organizationExternalInputSchema>;
export type OrganizationMerge = z.infer<typeof organizationMergeSchema>;
export type OrganizationErrorCode = z.infer<typeof organizationErrorSchema>['error']['code'];

export type OrganizationClaimDetail = z.infer<typeof organizationClaimDetailSchema>;
export type OrganizationClaimListQuery = z.input<typeof organizationClaimListQuerySchema>;

/** Staff curation corrects neutral facts or moderates visibility without claiming ownership. */
export const organizationCurationSchema = z
  .object({
    changes: updateOrganizationSchema.optional(),
    status: z.enum(['active', 'inactive', 'suppressed']).optional(),
    evidenceReference: z.string().trim().min(1).max(1000),
  })
  .strict()
  .refine(
    (input) => input.changes !== undefined || input.status !== undefined,
    'At least one change is required',
  );
export const organizationCurationResultSchema = z
  .object({ accountId: id, status: z.enum(['active', 'inactive', 'suppressed']) })
  .strict();
export type OrganizationCuration = z.infer<typeof organizationCurationSchema>;

export type OrganizationClaimList = z.infer<typeof organizationClaimListSchema>;
export type OrganizationImportBatchResult = z.infer<typeof organizationImportBatchResultSchema>;
export type OrganizationExternal = z.infer<typeof organizationExternalSchema>;
export type OrganizationExternalResolution = z.infer<typeof organizationExternalResolutionSchema>;
export type OrganizationCurationResult = z.infer<typeof organizationCurationResultSchema>;
