/**
 * Content claims (ADR 0042 D10) — the constants of the public "Report content
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
  /** A counter-notice failed validation; `fields` names each problem. */
  counterNoticeInvalid: 'CONTENT_CLAIM_COUNTER_NOTICE_INVALID',
  /** The files named are blocked by more than one claim: name the claim's reference. */
  counterNoticeAmbiguous: 'CONTENT_CLAIM_COUNTER_NOTICE_AMBIGUOUS',
  /** This account already sent a counter-notice for this claim. */
  counterNoticeExists: 'CONTENT_CLAIM_COUNTER_NOTICE_EXISTS',
} as const;

export type ContentClaimErrorCode =
  (typeof CONTENT_CLAIM_ERROR_CODES)[keyof typeof CONTENT_CLAIM_ERROR_CODES];

/**
 * A claim's reference as the claimant and the owner are sent it:
 * `OXY-XXXX-XXXX`, Crockford base32 (no I, L, O or U).
 */
export const CONTENT_CLAIM_REFERENCE_PATTERN = /^OXY-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** The bounds of an owner's counter-notice. The website fills its validation messages from these. */
export const CONTENT_CLAIM_COUNTER_NOTICE_LIMITS = {
  maxFileIds: 50,
  maxFileId: 64,
  maxName: 200,
  maxAddress: 500,
  minPhone: 5,
  maxPhone: 40,
  maxEmail: 254,
  minMaterial: 10,
  maxMaterial: 2000,
  maxLocation: 2048,
  minExplanation: 20,
  maxExplanation: 5000,
  maxSignature: 200,
} as const;

/**
 * The statements an owner's counter-notice makes, word for word — what the
 * form shows beside each box (17 U.S.C. § 512(g)(3)(C) and (D), and what Oxy
 * does with the notice). The API records {@link COUNTER_NOTICE_STATEMENT_VERSION}
 * with every notice, so the wording a person agreed to can always be told
 * apart from a later one. Change the text only together with the version.
 */
export const COUNTER_NOTICE_STATEMENTS = {
  perjury:
    'I swear, under penalty of perjury, that I have a good faith belief that the material identified above was removed or disabled as a result of a mistake or misidentification of the material to be removed or disabled.',
  jurisdiction:
    'I consent to the jurisdiction of the Federal District Court for the judicial district in which my address is located or, if my address is outside of the United States, any judicial district in which Oxy may be found.',
  serviceOfProcess:
    'I will accept service of process from the person who provided the notification of the claimed infringement, or an agent of such person.',
  disclosure:
    'I understand that Oxy sends a copy of this counter-notice, including my name and contact details, to the person who made the claim, as the law requires.',
} as const;

/** The version of {@link COUNTER_NOTICE_STATEMENTS} in force. */
export const COUNTER_NOTICE_STATEMENT_VERSION = '2026-10-16';
