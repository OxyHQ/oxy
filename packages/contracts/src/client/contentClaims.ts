/**
 * Content claims (ADR 0041 D10) — the constants of the public "Report content
 * / rights claim" intake and of a claim's review, without Zod. Schemas:
 * `../contentClaims.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

/** What a claim asserts. */
export const CONTENT_CLAIM_KINDS = [
  'copyright',
  'trademark',
  'privacy',
  'illegal_content',
  'other',
] as const;

export type ContentClaimKind = (typeof CONTENT_CLAIM_KINDS)[number];

/** Who the claimant is to the content. */
export const CLAIMANT_RELATIONSHIPS = [
  'rights_holder',
  'authorized_agent',
  'affected_person',
  'other',
] as const;

export type ClaimantRelationship = (typeof CLAIMANT_RELATIONSHIPS)[number];

/** The bounds of a submission. The website fills its validation messages from these. */
export const CONTENT_CLAIM_LIMITS = {
  minUrls: 1,
  maxUrls: 20,
  maxUrlLength: 2048,
  minDescription: 20,
  maxDescription: 5000,
  maxName: 200,
  maxOrganization: 200,
  maxEmail: 254,
} as const;

/**
 * Where a claim is in its review.
 *
 * `received → reviewing → actioned | rejected`; an actioned claim can be
 * answered by the content's owner (`counter_noticed`), which ends either in
 * `reinstated` (the content is served again) or `upheld` (it stays blocked).
 * A claim can also be rejected straight from `received`.
 */
export const CONTENT_CLAIM_STATES = [
  'received',
  'reviewing',
  'actioned',
  'rejected',
  'counter_noticed',
  'reinstated',
  'upheld',
] as const;

export type ContentClaimState = (typeof CONTENT_CLAIM_STATES)[number];

/** The states in which a claim is still open: its evidence is kept and its blocks can change. */
export const OPEN_CONTENT_CLAIM_STATES = [
  'received',
  'reviewing',
  'actioned',
  'counter_noticed',
] as const satisfies readonly ContentClaimState[];

/** The states a claim ends in. */
export const CLOSED_CONTENT_CLAIM_STATES = [
  'rejected',
  'reinstated',
  'upheld',
] as const satisfies readonly ContentClaimState[];

/**
 * The kinds whose claimant asserts a right in a work or a mark. Only these
 * carry the link to the original — a privacy or illegal-content report
 * asserts no ownership.
 */
export function isRightsClaim(kind: ContentClaimKind): boolean {
  return kind === 'copyright' || kind === 'trademark';
}

/**
 * A request to erase the claimant's OWN personal data (GDPR art. 17): a
 * privacy claim made by the person it is about. Oxy must answer it within one
 * month (art. 12(3)); the claim carries that deadline.
 */
export function isErasureRequest(
  kind: ContentClaimKind,
  relationship: ClaimantRelationship,
): boolean {
  return kind === 'privacy' && relationship === 'affected_person';
}

/** Days Oxy has to answer an erasure request ({@link isErasureRequest}). */
export const ERASURE_REQUEST_DEADLINE_DAYS = 30;

/**
 * Stable error codes a takedown produces elsewhere in the API. A file whose
 * bytes are on the blocklist cannot be uploaded, imported or copied by anyone
 * (HTTP 451).
 */
export const CONTENT_CLAIM_ERROR_CODES = {
  /** The submission failed validation; `fields` names each problem. */
  invalid: 'CONTENT_CLAIM_INVALID',
  /** These exact bytes were taken down after a claim and cannot be stored again. */
  contentBlocked: 'CONTENT_BLOCKED',
} as const;

export type ContentClaimErrorCode =
  (typeof CONTENT_CLAIM_ERROR_CODES)[keyof typeof CONTENT_CLAIM_ERROR_CODES];
