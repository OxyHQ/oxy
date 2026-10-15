import { z } from 'zod';
import { ORGANIZATION_TYPES } from './organizations';
import { reauthProofSchema } from './signIn';
import { userResponseSchema } from './userResponse';
import { accountActorChainSchema } from './accountSubject';
/** The requester is authenticated by the bearer; applications cannot submit viewer IDs. */
export const profileAccessInputSchema = z
  .object({ subjectAccountId: z.string().min(1).max(128) })
  .strict();
export const profileAccessDecisionSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.enum(['public', 'owner', 'private', 'blocked', 'unavailable']),
    policyVersion: z.literal('1'),
  })
  .strict();
export type ProfileAccessInput = z.infer<typeof profileAccessInputSchema>;
export type ProfileAccessDecision = z.infer<typeof profileAccessDecisionSchema>;

/** Supervision is a personal-account safety policy, never a new login/account kind. */
export const SUPERVISED_ACTIONS = ['profile', 'messaging', 'content', 'purchases'] as const;
export type SupervisedAction = (typeof SUPERVISED_ACTIONS)[number];
export const SAFETY_POLICY_VERSION = '2' as const;
export const SUPERVISION_CONSENT_VERSION = '1' as const;
export const SAFETY_DECISION_REASONS = [
  'allowed',
  'owner',
  'public',
  'private',
  'blocked',
  'unavailable',
  'unsupported_consumer',
  'contact_not_approved',
  'mature_content',
  'unrated_content',
  'approval_required',
] as const;
const accountId = z.string().min(1).max(128);
const resourceId = z.string().trim().min(1).max(256);
const uniqueIds = (max: number, min = 1) =>
  z
    .array(accountId)
    .min(min)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, 'Account IDs must be unique');
export const safetyDecisionSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.enum(SAFETY_DECISION_REASONS),
    policyVersion: z.literal(SAFETY_POLICY_VERSION),
  })
  .strict();
export type SafetyDecision = z.infer<typeof safetyDecisionSchema>;
export const profileAccessBatchInputSchema = z
  .object({ subjectAccountIds: uniqueIds(100) })
  .strict();
export const profileAccessBatchResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            subjectAccountId: accountId,
            decision: safetyDecisionSchema,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const MESSAGE_ACCESS_MAX_RESOURCES = 100;
export const MESSAGE_ACCESS_MAX_PARTICIPANTS = 1024;
export const MESSAGE_ACCESS_MAX_SUPERVISED_PARTICIPANTS = 256;
export const MESSAGE_ACCESS_MAX_PARTICIPANT_SLOTS = 4096;
/** Leaves room for the original requester proof in a 512 KiB request. */
export const MESSAGE_ACCESS_MAX_INPUT_BYTES = 448 * 1024;
export const messageAccessInputSchema = z
  .object({ participantAccountIds: uniqueIds(MESSAGE_ACCESS_MAX_PARTICIPANTS), resourceId })
  .strict();
export const contactAccessInputSchema = z.object({ targetAccountIds: uniqueIds(1000) }).strict();
export const contactAccessResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            targetAccountId: accountId,
            decision: safetyDecisionSchema,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export const CONTENT_CLASSIFICATIONS = ['general', 'mature', 'unrated'] as const;
export const contentAccessInputSchema = z
  .object({
    resourceId,
    classification: z.enum(CONTENT_CLASSIFICATIONS),
    authorAccountId: accountId.optional(),
    audience: z.enum(['public', 'private', 'followers']).optional(),
    applicationAudienceAllowed: z.boolean().optional(),
    applicationResourceGrant: z.boolean().optional(),
    operation: z.enum(['read', 'manage_own']).optional(),
  })
  .strict()
  .refine(
    (item) =>
      !item.audience ||
      item.audience === 'public' ||
      (!!item.authorAccountId && item.applicationAudienceAllowed !== undefined),
    'Nonpublic content requires its authoritative author and application audience decision',
  )
  .refine(
    (item) => item.operation !== 'manage_own' || !!item.authorAccountId,
    'Own management requires its authoritative author',
  );
export const publicationPolicySchema = z
  .object({
    publicationAllowed: z.boolean(),
    requiredAudience: z.literal('private').nullable(),
    collaborationAllowed: z.boolean(),
    federationAllowed: z.boolean(),
    policyVersion: z.literal(SAFETY_POLICY_VERSION),
  })
  .strict();
export const publicationPoliciesInputSchema = z
  .object({
    authorAccountIds: z
      .array(accountId)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Author IDs must be unique'),
  })
  .strict();
export const publicationPoliciesResponseSchema = z
  .object({
    items: z
      .array(z.object({ authorAccountId: accountId, policy: publicationPolicySchema }).strict())
      .max(100),
  })
  .strict();
export type PublicationPoliciesInput = z.infer<typeof publicationPoliciesInputSchema>;
export type PublicationPolicy = z.infer<typeof publicationPolicySchema>;
export const contentAccessBatchInputSchema = z
  .object({
    items: z
      .array(contentAccessInputSchema)
      .min(1)
      .max(100)
      .refine(
        (items) => new Set(items.map((item) => item.resourceId)).size === items.length,
        'Resource IDs must be unique',
      ),
  })
  .strict();
export const contentAccessBatchResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            resourceId,
            decision: safetyDecisionSchema,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
/** A reviewed background consumer may decide delivery, but never authenticate as the sender. */
export const deliveryAccessInputSchema = messageAccessInputSchema
  .extend({ senderAccountId: accountId })
  .strict();
/** Count repeated participants across resources too: this bounds both graph and pair evaluations. */
const messageBatch = <T extends typeof messageAccessInputSchema | typeof deliveryAccessInputSchema>(
  schema: T,
) =>
  z
    .object({ items: z.array(schema).min(1).max(MESSAGE_ACCESS_MAX_RESOURCES) })
    .strict()
    .refine(
      (value) => new Set(value.items.map((item) => item.resourceId)).size === value.items.length,
      'Resource IDs must be unique',
    )
    .refine(
      (value) =>
        value.items.reduce((total, item) => total + item.participantAccountIds.length, 0) <=
        MESSAGE_ACCESS_MAX_PARTICIPANT_SLOTS,
      'Participant budget exceeded',
    )
    .refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        MESSAGE_ACCESS_MAX_INPUT_BYTES,
      'Message batch byte budget exceeded',
    );
export const messageAccessBatchInputSchema = messageBatch(messageAccessInputSchema);
export const deliveryAccessBatchInputSchema = messageBatch(deliveryAccessInputSchema);
export const messageAccessBatchResponseSchema = contentAccessBatchResponseSchema;
export type MessageAccessBatchInput = z.infer<typeof messageAccessBatchInputSchema>;
export type DeliveryAccessBatchInput = z.infer<typeof deliveryAccessBatchInputSchema>;
/** Live socket-recipient proof; a request ID correlates the result and never identifies an account. */
export const messagingSessionsInputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            requestId: resourceId,
            accessToken: z.string().min(1).max(16384),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (value) => new Set(value.items.map((item) => item.requestId)).size === value.items.length,
    'Request IDs must be unique',
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= MESSAGE_ACCESS_MAX_INPUT_BYTES,
    'Session proof byte budget exceeded',
  );
export const messagingSessionsResponseSchema = z
  .object({
    items: z
      .array(
        z.discriminatedUnion('allowed', [
          z.object({ requestId: resourceId, allowed: z.literal(true), accountId }).strict(),
          z.object({ requestId: resourceId, allowed: z.literal(false) }).strict(),
        ]),
      )
      .max(100),
  })
  .strict();
export type MessagingSessionsInput = z.infer<typeof messagingSessionsInputSchema>;
export const safetyRequesterSchema = z.union([
  z.object({ accessToken: z.string().min(1).max(16384).nullable() }).strict(),
  z.object({ connectionToken: z.string().min(1).max(16384) }).strict(),
]);
export type SafetyRequester = z.infer<typeof safetyRequesterSchema>;
export type ProfileAccessBatchInput = z.infer<typeof profileAccessBatchInputSchema>;
export type MessageAccessInput = z.infer<typeof messageAccessInputSchema>;
export type ContactAccessInput = z.infer<typeof contactAccessInputSchema>;
export type ContentAccessInput = z.infer<typeof contentAccessInputSchema>;
export type ContentAccessBatchInput = z.infer<typeof contentAccessBatchInputSchema>;
export type DeliveryAccessInput = z.infer<typeof deliveryAccessInputSchema>;

export const SUPERVISION_STATUSES = ['active', 'orphaned', 'ended'] as const;
export const SUPERVISION_INVITATION_STATUSES = ['pending', 'accepted', 'cancelled'] as const;
export const supervisionSchema = z
  .object({
    childAccountId: accountId,
    guardianAccountId: accountId.nullable(),
    status: z.enum(SUPERVISION_STATUSES),
    policyVersion: z.literal(SAFETY_POLICY_VERSION),
    consentVersion: z.literal(SUPERVISION_CONSENT_VERSION),
    createdAt: z.string().datetime(),
  })
  .strict();
export const supervisionInvitationSchema = z
  .object({
    id: accountId,
    childAccountId: accountId,
    guardianAccountId: accountId,
    status: z.enum(SUPERVISION_INVITATION_STATUSES),
    expiresAt: z.string().datetime(),
    consentVersion: z.literal(SUPERVISION_CONSENT_VERSION),
    createdAt: z.string().datetime(),
  })
  .strict();
export const supervisionContactSchema = z
  .object({
    childAccountId: accountId,
    contactAccountId: accountId,
    approvedAt: z.string().datetime(),
  })
  .strict();
export const supervisionStateSchema = z
  .object({
    self: supervisionSchema.nullable(),
    children: z.array(supervisionSchema).max(100),
    invitations: z.array(supervisionInvitationSchema).max(100),
  })
  .strict();
export const supervisionContactsResponseSchema = z
  .object({ items: z.array(supervisionContactSchema).max(1000) })
  .strict();
export type Supervision = z.infer<typeof supervisionSchema>;
export type SupervisionInvitation = z.infer<typeof supervisionInvitationSchema>;

export const PURCHASE_APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'reserved',
  'confirmed',
  'cancelled',
] as const;
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const minorUnits = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const purchaseApprovalLineSchema = z
  .object({
    itemReference: resourceId,
    title: z.string().trim().min(1).max(300),
    optionsText: z.string().trim().max(300),
    merchantAccountId: accountId,
    quantity: z.number().int().min(1).max(1000000),
    unitAmountMinor: minorUnits,
    lineAmountMinor: minorUnits,
  })
  .strict();
const purchaseEffectsObject = z
  .object({
    operationId: resourceId,
    resourceId,
    cartFingerprint: fingerprint,
    summary: z.string().trim().min(1).max(300),
    merchantAccountIds: z
      .array(accountId)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Merchant accounts must be unique')
      .transform((ids) => [...ids].sort()),
    lineItems: z.array(purchaseApprovalLineSchema).min(1).max(200),
    shippingMinor: minorUnits,
    taxMinor: minorUnits,
    discountMinor: minorUnits,
    roundingAdjustmentMinor: z
      .number()
      .int()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER),
    paymentFingerprint: fingerprint,
    amountMinor: minorUnits,
    currency: z.string().regex(/^[A-Z]{3}$/),
    expiresAt: z.string().datetime(),
  })
  .strict();
function validatePurchaseEvidence(
  value: z.infer<typeof purchaseEffectsObject>,
  ctx: z.RefinementCtx,
) {
  const merchants = new Set(value.merchantAccountIds);
  const references = new Set<string>();
  for (const line of value.lineItems) {
    const key = `${line.merchantAccountId}:${line.itemReference}`;
    if (!merchants.has(line.merchantAccountId) || references.has(key))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Purchase lines must name an included merchant and unique item reference',
      });
    references.add(key);
  }
  if (merchants.size !== new Set(value.lineItems.map((line) => line.merchantAccountId)).size)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Every merchant must have an approval line',
    });
  const total =
    value.lineItems.reduce((sum, line) => sum + BigInt(line.lineAmountMinor), 0n) +
    BigInt(value.shippingMinor) +
    BigInt(value.taxMinor) -
    BigInt(value.discountMinor) +
    BigInt(value.roundingAdjustmentMinor);
  if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER) || total !== BigInt(value.amountMinor))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Approval evidence must equal the exact payment total',
    });
  if (
    Math.abs(value.roundingAdjustmentMinor) >
    value.lineItems.length + 3 * value.merchantAccountIds.length
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Rounding adjustment exceeds the bounded conversion stages',
    });
}
export const purchaseEffectsSchema = purchaseEffectsObject.superRefine(validatePurchaseEvidence);
const purchaseApprovalFields = {
  id: accountId,
  childAccountId: accountId,
  applicationId: accountId,
  status: z.enum(PURCHASE_APPROVAL_STATUSES),
  createdAt: z.string().datetime(),
  receiptReference: z.string().max(512).nullable(),
};
export const purchaseApprovalSchema = purchaseEffectsObject
  .extend(purchaseApprovalFields)
  .strict()
  .superRefine(validatePurchaseEvidence);
export const purchaseApprovalSummarySchema = purchaseEffectsObject
  .omit({ lineItems: true })
  .extend(purchaseApprovalFields)
  .strict();
export const purchaseApprovalListSchema = z
  .object({
    items: z.array(purchaseApprovalSummarySchema).max(100),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const reservePurchaseSchema = purchaseEffectsObject
  .extend({ approvalId: accountId })
  .strict()
  .superRefine(validatePurchaseEvidence);
export type PurchaseApprovalLine = z.infer<typeof purchaseApprovalLineSchema>;
export type PurchaseApprovalSummary = z.infer<typeof purchaseApprovalSummarySchema>;
export const confirmPurchaseSchema = z
  .object({
    approvalId: accountId,
    operationId: resourceId,
    receiptReference: z.string().trim().min(1).max(512),
  })
  .strict();
export const cancelPurchaseSchema = confirmPurchaseSchema.omit({ receiptReference: true });
export type PurchaseEffects = z.infer<typeof purchaseEffectsSchema>;
export type PurchaseApproval = z.infer<typeof purchaseApprovalSchema>;
export type ReservePurchase = z.infer<typeof reservePurchaseSchema>;
export type ConfirmPurchase = z.infer<typeof confirmPurchaseSchema>;
export type CancelPurchase = z.infer<typeof cancelPurchaseSchema>;
export const SAFETY_ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'reauth_required',
  'limit_reached',
  'service_unavailable',
  'rate_limited',
] as const;
export const safetyErrorSchema = z
  .object({ error: z.object({ code: z.enum(SAFETY_ERROR_CODES), message: z.string() }).strict() })
  .strict();
export type SafetyErrorCode = (typeof SAFETY_ERROR_CODES)[number];

export const supervisionInviteInputSchema = z
  .object({
    guardianAccountId: accountId,
    consentVersion: z.literal(SUPERVISION_CONSENT_VERSION),
    reauth: reauthProofSchema,
  })
  .strict();
export const supervisionAcceptInputSchema = z
  .object({ consentVersion: z.literal(SUPERVISION_CONSENT_VERSION), reauth: reauthProofSchema })
  .strict();
export const supervisionContactInputSchema = z
  .object({ childAccountId: accountId, contactAccountId: accountId, reauth: reauthProofSchema })
  .strict();
export const supervisionReviewInputSchema = z
  .object({
    childAccountId: accountId,
    action: z.enum(['end', 'transfer']),
    guardianAccountId: accountId.optional(),
    evidenceReference: z.string().trim().min(1).max(2048),
    reauth: reauthProofSchema,
  })
  .strict();
export const purchaseReviewInputSchema = z
  .object({ decision: z.enum(['approved', 'rejected']), reauth: reauthProofSchema })
  .strict();
export type SupervisionInviteInput = z.infer<typeof supervisionInviteInputSchema>;
export type SupervisionAcceptInput = z.infer<typeof supervisionAcceptInputSchema>;
export type SupervisionContactInput = z.infer<typeof supervisionContactInputSchema>;
export type SupervisionReviewInput = z.infer<typeof supervisionReviewInputSchema>;
export type PurchaseReviewInput = z.infer<typeof purchaseReviewInputSchema>;

export const safetySessionInputSchema = z
  .object({
    sessionId: accountId,
    accessToken: z.string().min(1).max(16384),
    action: z.enum(SUPERVISED_ACTIONS),
  })
  .strict();
export const safetySessionValidationSchema = z
  .object({
    valid: z.literal(true),
    sessionId: accountId,
    expiresAt: z.string().datetime(),
    lastActivity: z.string().datetime(),
    user: userResponseSchema,
    actor: accountActorChainSchema,
  })
  .strict();

/** Minimal identity for the authenticated account's supervision management, never profile details. */
export const safetyPersonSchema = z
  .object({ accountId, username: z.string().nullable(), displayName: z.string().nullable() })
  .strict();
export const safetyPeopleInputSchema = z.union([
  z.object({ query: z.string().trim().min(2).max(100) }).strict(),
  z.object({ accountIds: uniqueIds(100) }).strict(),
]);
export const safetyPeopleResponseSchema = z
  .object({ items: z.array(safetyPersonSchema).max(100) })
  .strict();
export type SafetyPerson = z.infer<typeof safetyPersonSchema>;
export type SafetyPeopleInput = z.infer<typeof safetyPeopleInputSchema>;

/** Existing public employer identity only; never directory content or management authority. */
export const safetyOrganizationIdentitySchema = z
  .object({
    accountId,
    username: z.string().nullable(),
    name: z.string(),
    organizationType: z.enum(ORGANIZATION_TYPES),
  })
  .strict();
export const safetyOrganizationsInputSchema = z.union([
  z
    .object({
      query: z.string().trim().min(1).max(100),
      limit: z.number().int().min(1).max(20).optional(),
    })
    .strict(),
  z.object({ ids: uniqueIds(100) }).strict(),
]);
export const safetyOrganizationsResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({ requestedAccountId: accountId, organization: safetyOrganizationIdentitySchema })
          .strict(),
      )
      .max(100),
    missingIds: z.array(accountId).max(100),
  })
  .strict();
export type SafetyOrganizationIdentity = z.infer<typeof safetyOrganizationIdentitySchema>;
export type SafetyOrganizationsInput = z.infer<typeof safetyOrganizationsInputSchema>;
