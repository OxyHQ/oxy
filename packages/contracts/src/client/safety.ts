/**
 * Safety and supervision checks, without Zod. Schemas: `../safety.ts`.
 *
 * Only what a browser or device sends and reads is here: the profile-access
 * read, supervision management and the guardian's purchase review. The service
 * decision lanes are server-only (`@oxy.so/core/server`) and parse with the
 * Zod schemas directly.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type {
  ProfileAccessDecision,
  ProfileAccessInput,
  PurchaseApproval,
  PurchaseApprovalLine,
  PurchaseApprovalList,
  PurchaseApprovalSummary,
  PurchaseReviewInput,
  SafetyOrganizationsInput,
  SafetyOrganizationsResponse,
  SafetyPeopleInput,
  SafetyPeopleResponse,
  SafetyPerson,
  Supervision,
  SupervisionAcceptInput,
  SupervisionContactInput,
  SupervisionContactsResponse,
  SupervisionInvitation,
  SupervisionInviteInput,
  SupervisionReviewInput,
  SupervisionState,
} from '../safety';
import {
  array,
  atLeast,
  atMost,
  boolean,
  type Check,
  type CheckPath,
  datetime,
  exact,
  int,
  literal,
  maxItems,
  maxLength,
  minItems,
  minLength,
  nonnegative,
  nullable,
  number,
  oneOf,
  optional,
  pattern,
  refine,
  refineAt,
  strictObject,
  string,
  transform,
  trim,
  union,
} from './check';
import { ORGANIZATION_TYPES } from './organizations';
import { reauthProofCheck } from './signIn';

/** Supervision is a personal-account safety policy, never a new login/account kind. */
export const SUPERVISED_ACTIONS = ['profile', 'messaging', 'content', 'purchases'] as const;
export const SAFETY_POLICY_VERSION = '2' as const;
export const SUPERVISION_CONSENT_VERSION = '1' as const;
export const SUPERVISION_STATUSES = ['active', 'orphaned', 'ended'] as const;
export const SUPERVISION_INVITATION_STATUSES = ['pending', 'accepted', 'cancelled'] as const;
/**
 * Token-free Socket.IO signal emitted to room `user:<accountId>` whenever that
 * account's supervision state (`GET /safety/supervision`) changes: an invitation
 * is created, cancelled or accepted, or supervision is transferred or ended. It
 * carries no payload; a client refetches its own state. The state it refreshes
 * is advisory: the server enforces supervision on every request regardless.
 */
export const SUPERVISION_CHANGED_EVENT = 'supervision_changed';
export const PURCHASE_APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'reserved',
  'confirmed',
  'cancelled',
] as const;

export const profileAccessInputCheck = exact<ProfileAccessInput>()(
  strictObject({ subjectAccountId: string(minLength(1), maxLength(128)) }),
);

export const profileAccessDecisionCheck = exact<ProfileAccessDecision>()(
  strictObject({
    allowed: boolean,
    reason: oneOf(['public', 'owner', 'private', 'blocked', 'unavailable']),
    policyVersion: literal('1'),
  }),
);

const accountId = string(minLength(1), maxLength(128));
const resourceId = string(trim, minLength(1), maxLength(256));
const uniqueIds = (max: number) =>
  refine(
    array(accountId, minItems(1), maxItems(max)),
    (ids) => new Set(ids).size === ids.length,
    'Account IDs must be unique',
  );

/* -------------------------------------------------------------------------- */
/*  Supervision management                                                    */
/* -------------------------------------------------------------------------- */

const supervisionCheck = exact<Supervision>()(
  strictObject({
    childAccountId: accountId,
    guardianAccountId: nullable(accountId),
    status: oneOf(SUPERVISION_STATUSES),
    policyVersion: literal(SAFETY_POLICY_VERSION),
    consentVersion: literal(SUPERVISION_CONSENT_VERSION),
    createdAt: string(datetime),
  }),
);

export const supervisionInvitationCheck = exact<SupervisionInvitation>()(
  strictObject({
    id: accountId,
    childAccountId: accountId,
    guardianAccountId: accountId,
    status: oneOf(SUPERVISION_INVITATION_STATUSES),
    expiresAt: string(datetime),
    consentVersion: literal(SUPERVISION_CONSENT_VERSION),
    createdAt: string(datetime),
  }),
);

export const supervisionStateCheck = exact<SupervisionState>()(
  strictObject({
    self: nullable(supervisionCheck),
    children: array(supervisionCheck, maxItems(100)),
    invitations: array(supervisionInvitationCheck, maxItems(100)),
  }),
);

export const supervisionContactsResponseCheck = exact<SupervisionContactsResponse>()(
  strictObject({
    items: array(
      strictObject({
        childAccountId: accountId,
        contactAccountId: accountId,
        approvedAt: string(datetime),
      }),
      maxItems(1000),
    ),
  }),
);

export const supervisionInviteInputCheck = exact<SupervisionInviteInput>()(
  strictObject({
    guardianAccountId: accountId,
    consentVersion: literal(SUPERVISION_CONSENT_VERSION),
    reauth: reauthProofCheck,
  }),
);

export const supervisionAcceptInputCheck = exact<SupervisionAcceptInput>()(
  strictObject({ consentVersion: literal(SUPERVISION_CONSENT_VERSION), reauth: reauthProofCheck }),
);

export const supervisionContactInputCheck = exact<SupervisionContactInput>()(
  strictObject({
    childAccountId: accountId,
    contactAccountId: accountId,
    reauth: reauthProofCheck,
  }),
);

export const supervisionReviewInputCheck = exact<SupervisionReviewInput>()(
  strictObject({
    childAccountId: accountId,
    action: oneOf(['end', 'transfer']),
    guardianAccountId: optional(accountId),
    evidenceReference: string(trim, minLength(1), maxLength(2048)),
    reauth: reauthProofCheck,
  }),
);

/* -------------------------------------------------------------------------- */
/*  Minimal identities for the management screens                            */
/* -------------------------------------------------------------------------- */

const safetyPersonCheck = exact<SafetyPerson>()(
  strictObject({ accountId, username: nullable(string()), displayName: nullable(string()) }),
);

export const safetyPeopleInputCheck = exact<SafetyPeopleInput>()(
  union(
    strictObject({ query: string(trim, minLength(2), maxLength(100)) }),
    strictObject({ accountIds: uniqueIds(100) }),
  ),
);

export const safetyPeopleResponseCheck = exact<SafetyPeopleResponse>()(
  strictObject({ items: array(safetyPersonCheck, maxItems(100)) }),
);

export const safetyOrganizationsInputCheck = exact<SafetyOrganizationsInput>()(
  union(
    strictObject({
      query: string(trim, minLength(1), maxLength(100)),
      limit: optional(number(int, atLeast(1), atMost(20))),
    }),
    strictObject({ ids: uniqueIds(100) }),
  ),
);

export const safetyOrganizationsResponseCheck = exact<SafetyOrganizationsResponse>()(
  strictObject({
    items: array(
      strictObject({
        requestedAccountId: accountId,
        organization: strictObject({
          accountId,
          username: nullable(string()),
          name: string(),
          organizationType: oneOf(ORGANIZATION_TYPES),
        }),
      }),
      maxItems(100),
    ),
    missingIds: array(accountId, maxItems(100)),
  }),
);

/* -------------------------------------------------------------------------- */
/*  Purchase approvals                                                        */
/* -------------------------------------------------------------------------- */

const fingerprint = string(pattern(/^[a-f0-9]{64}$/));
const minorUnits = number(int, nonnegative, atMost(Number.MAX_SAFE_INTEGER));

const purchaseApprovalLineCheck = exact<PurchaseApprovalLine>()(
  strictObject({
    itemReference: resourceId,
    title: string(trim, minLength(1), maxLength(300)),
    optionsText: string(trim, maxLength(300)),
    merchantAccountId: accountId,
    quantity: number(int, atLeast(1), atMost(1000000)),
    unitAmountMinor: minorUnits,
    lineAmountMinor: minorUnits,
  }),
);

/** The effect fields every approval shape shares, in the schema's key order. */
const purchaseEffectFields = {
  operationId: resourceId,
  resourceId,
  cartFingerprint: fingerprint,
  summary: string(trim, minLength(1), maxLength(300)),
  merchantAccountIds: transform(
    refine(
      array(accountId, minItems(1), maxItems(100)),
      (ids) => new Set(ids).size === ids.length,
      'Merchant accounts must be unique',
    ),
    (ids) => [...ids].sort(),
  ),
};
const purchaseAmountFields = {
  shippingMinor: minorUnits,
  taxMinor: minorUnits,
  discountMinor: minorUnits,
  roundingAdjustmentMinor: number(
    int,
    atLeast(-Number.MAX_SAFE_INTEGER),
    atMost(Number.MAX_SAFE_INTEGER),
  ),
  paymentFingerprint: fingerprint,
  amountMinor: minorUnits,
  currency: string(pattern(/^[A-Z]{3}$/)),
  expiresAt: string(datetime),
};
const purchaseApprovalFields = {
  id: accountId,
  childAccountId: accountId,
  applicationId: accountId,
  status: oneOf(PURCHASE_APPROVAL_STATUSES),
  createdAt: string(datetime),
  receiptReference: nullable(string(maxLength(512))),
};

/** The first problem `validatePurchaseEvidence` in `../safety.ts` reports, in its order. */
function purchaseEvidenceProblem(value: {
  merchantAccountIds: string[];
  lineItems: PurchaseApprovalLine[];
  shippingMinor: number;
  taxMinor: number;
  discountMinor: number;
  roundingAdjustmentMinor: number;
  amountMinor: number;
}): { path: CheckPath; message: string } | undefined {
  const merchants = new Set(value.merchantAccountIds);
  const references = new Set<string>();
  for (const line of value.lineItems) {
    const key = `${line.merchantAccountId}:${line.itemReference}`;
    if (!merchants.has(line.merchantAccountId) || references.has(key)) {
      return {
        path: [],
        message: 'Purchase lines must name an included merchant and unique item reference',
      };
    }
    references.add(key);
  }
  if (merchants.size !== new Set(value.lineItems.map((line) => line.merchantAccountId)).size) {
    return { path: [], message: 'Every merchant must have an approval line' };
  }
  const total =
    value.lineItems.reduce((sum, line) => sum + BigInt(line.lineAmountMinor), 0n) +
    BigInt(value.shippingMinor) +
    BigInt(value.taxMinor) -
    BigInt(value.discountMinor) +
    BigInt(value.roundingAdjustmentMinor);
  if (
    total < 0n ||
    total > BigInt(Number.MAX_SAFE_INTEGER) ||
    total !== BigInt(value.amountMinor)
  ) {
    return { path: [], message: 'Approval evidence must equal the exact payment total' };
  }
  if (
    Math.abs(value.roundingAdjustmentMinor) >
    value.lineItems.length + 3 * value.merchantAccountIds.length
  ) {
    return { path: [], message: 'Rounding adjustment exceeds the bounded conversion stages' };
  }
  return undefined;
}

export const purchaseApprovalCheck = exact<PurchaseApproval>()(
  refineAt(
    strictObject({
      ...purchaseEffectFields,
      lineItems: array(purchaseApprovalLineCheck, minItems(1), maxItems(200)),
      ...purchaseAmountFields,
      ...purchaseApprovalFields,
    }),
    purchaseEvidenceProblem,
  ),
);

const purchaseApprovalSummaryCheck = exact<PurchaseApprovalSummary>()(
  strictObject({ ...purchaseEffectFields, ...purchaseAmountFields, ...purchaseApprovalFields }),
);

export const purchaseApprovalListCheck = exact<PurchaseApprovalList>()(
  strictObject({
    items: array(purchaseApprovalSummaryCheck, maxItems(100)),
    nextCursor: nullable(string()),
  }),
);

export const purchaseReviewInputCheck = exact<PurchaseReviewInput>()(
  strictObject({ decision: oneOf(['approved', 'rejected']), reauth: reauthProofCheck }),
);
