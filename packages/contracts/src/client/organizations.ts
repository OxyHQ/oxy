/**
 * Organization vocabularies and checks, without Zod. Schemas: `../organizations.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type {
  CreateOrganization,
  Organization,
  OrganizationBatch,
  OrganizationClaim,
  OrganizationClaimDetail,
  OrganizationClaimInput,
  OrganizationClaimList,
  OrganizationClaimReview,
  OrganizationCurationResult,
  OrganizationExternal,
  OrganizationExternalResolution,
  OrganizationImportBatchResult,
  OrganizationList,
  UpdateOrganization,
} from '../organizations';
import { ACCOUNT_TITLE_MAX_LENGTH, accountTitleCheck } from './accountName';
import {
  array,
  boolean,
  type Check,
  datetime,
  exact,
  maxItems,
  maxLength,
  minLength,
  nullable,
  oneOf,
  optional,
  pattern,
  refine,
  strictObject,
  string,
  trim,
  url,
} from './check';

/** Real-world identity classification, independent of account topics and permissions. */
export const ORGANIZATION_TYPES = [
  'business',
  'nonprofit',
  'public_body',
  'community',
  'other',
] as const;

export const ORGANIZATION_STATUSES = ['active', 'inactive', 'merged', 'suppressed'] as const;

export const ORGANIZATION_CLAIM_STATUSES = ['unclaimed', 'claimed'] as const;

export const ORGANIZATION_ALIAS_KINDS = [
  'name_variant',
  'former_name',
  'localized_name',
  'marketing_name',
  'misspelling',
] as const;

export const ORGANIZATION_CLAIM_DECISIONS = ['pending', 'approved', 'rejected'] as const;

/** An organization's name is a title; the cap is the title policy's. */
export const ORGANIZATION_NAME_MAX_LENGTH = ACCOUNT_TITLE_MAX_LENGTH;

export const ORGANIZATION_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'unknown_route',
  'conflict',
  'validation_failed',
  'rate_limited',
  'internal_error',
  'service_unavailable',
] as const;

/* -------------------------------------------------------------------------- */
/*  Checks                                                                    */
/* -------------------------------------------------------------------------- */

const id = string(minLength(1), maxLength(128));
const optionalText = (max: number) =>
  optional(nullable(string(trim, minLength(1), maxLength(max))));
const evidenceReference = string(trim, minLength(1), maxLength(1000));
const createdAt = string(datetime);

const organizationAlias = strictObject({
  alias: string(trim, minLength(1), maxLength(300)),
  kind: oneOf(ORGANIZATION_ALIAS_KINDS),
  language: optional(string(minLength(2), maxLength(35))),
});

/** The twin of `organizationNameSchema`: the title policy (`./accountName.ts`). */
export const organizationNameCheck: Check<string> = accountTitleCheck;

const organizationFields = {
  name: organizationNameCheck,
  organizationType: oneOf(ORGANIZATION_TYPES),
  legalName: optionalText(300),
  websiteUrl: optional(
    nullable(
      refine(
        string(url, maxLength(2048)),
        (value) => /^https?:\/\//.test(value),
        'Use HTTP or HTTPS',
      ),
    ),
  ),
  countryCode: optional(nullable(string(pattern(/^[A-Z]{2}$/)))),
  aliases: optional(array(organizationAlias, maxItems(100))),
};

export const createOrganizationCheck = exact<CreateOrganization>()(
  strictObject(organizationFields),
);

export const updateOrganizationCheck = exact<UpdateOrganization>()(
  strictObject({
    ...organizationFields,
    name: optional(organizationNameCheck),
    organizationType: optional(organizationFields.organizationType),
  }),
);

export const organizationCheck = exact<Organization>()(
  strictObject({
    name: organizationNameCheck,
    organizationType: oneOf(ORGANIZATION_TYPES),
    legalName: nullable(string()),
    websiteUrl: nullable(string()),
    countryCode: nullable(string()),
    aliases: array(organizationAlias),
    accountId: id,
    username: nullable(string()),
    avatar: nullable(string()),
    verifiedDomains: array(string()),
    claimStatus: oneOf(ORGANIZATION_CLAIM_STATUSES),
    status: oneOf(ORGANIZATION_STATUSES),
    mergedIntoAccountId: nullable(id),
    createdAt,
    updatedAt: string(datetime),
  }),
);

export const organizationListCheck = exact<OrganizationList>()(
  strictObject({ items: array(organizationCheck), nextCursor: nullable(string()) }),
);

export const organizationBatchCheck = exact<OrganizationBatch>()(
  strictObject({
    items: array(strictObject({ requestedAccountId: id, organization: organizationCheck })),
    missingIds: array(id),
  }),
);

export const organizationClaimInputCheck = exact<OrganizationClaimInput>()(
  strictObject({ evidenceReference }),
);

const organizationClaimFields = {
  id,
  accountId: id,
  claimantUserId: id,
  status: oneOf(ORGANIZATION_CLAIM_DECISIONS),
  createdAt,
};

export const organizationClaimCheck = exact<OrganizationClaim>()(
  strictObject(organizationClaimFields),
);

export const organizationClaimDetailCheck = exact<OrganizationClaimDetail>()(
  strictObject({
    ...organizationClaimFields,
    evidenceReference: string(),
    reviewEvidenceReference: nullable(string()),
    reviewedAt: nullable(string(datetime)),
  }),
);

export const organizationClaimListCheck = exact<OrganizationClaimList>()(
  strictObject({ items: array(organizationClaimDetailCheck), nextCursor: nullable(string()) }),
);

export const organizationClaimReviewCheck = exact<OrganizationClaimReview>()(
  strictObject({ decision: oneOf(['approved', 'rejected']), evidenceReference }),
);

export const organizationImportBatchResultCheck = exact<OrganizationImportBatchResult>()(
  strictObject({
    items: array(strictObject({ externalId: string(), accountId: id, created: boolean })),
  }),
);

export const organizationExternalCheck = exact<OrganizationExternal>()(
  strictObject({ accountId: id, created: boolean }),
);

export const organizationExternalResolutionCheck = exact<OrganizationExternalResolution>()(
  strictObject({ accountId: id }),
);

export const organizationCurationResultCheck = exact<OrganizationCurationResult>()(
  strictObject({ accountId: id, status: oneOf(['active', 'inactive', 'suppressed']) }),
);
