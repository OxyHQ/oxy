/**
 * Content claims (ADR 0043 D10): the public "Report content / rights claim"
 * intake, `POST /content-claims`, and the staff review of a claim.
 *
 * {@link contentClaimSubmissionSchema} is the request body the API parses and
 * the Oxy website validates its form with before posting, so the form cannot
 * accept what the API would answer 400 to. Every validation message is a
 * stable KEY under `contentClaim.errors.*` (filled with
 * {@link CONTENT_CLAIM_LIMITS} by whoever shows it), never English: the website
 * translates the key, and the API answers its own English sentence for it in
 * `fields`.
 */
import { z } from 'zod';
// The Zod-free half of this contract lives in `./client/` (`@oxy.so/contracts/client`);
// it is re-exported here so the root entry carries the whole contract.
import {
  CLAIMANT_RELATIONSHIPS,
  CONTENT_CLAIM_COUNTER_NOTICE_LIMITS,
  CONTENT_CLAIM_KINDS,
  CONTENT_CLAIM_LIMITS,
  CONTENT_CLAIM_REFERENCE_PATTERN,
  type ClaimantRelationship,
  type ContentClaimKind,
  type ContentClaimState,
} from './client/contentClaims';
export {
  CLAIMANT_RELATIONSHIPS,
  CLOSED_CONTENT_CLAIM_STATES,
  CONTENT_CLAIM_COUNTER_NOTICE_LIMITS,
  CONTENT_CLAIM_ERROR_CODES,
  CONTENT_CLAIM_KINDS,
  CONTENT_CLAIM_LIMITS,
  CONTENT_CLAIM_REFERENCE_PATTERN,
  CONTENT_CLAIM_STATES,
  COUNTER_NOTICE_STATEMENT_VERSION,
  COUNTER_NOTICE_STATEMENTS,
  ERASURE_REQUEST_DEADLINE_DAYS,
  OPEN_CONTENT_CLAIM_STATES,
  isErasureRequest,
  isRightsClaim,
} from './client/contentClaims';
export type {
  ClaimantRelationship,
  ContentClaimErrorCode,
  ContentClaimKind,
  ContentClaimState,
} from './client/contentClaims';

/** Every key a submission's validation can produce, under `contentClaim.errors.*`. */
export const CONTENT_CLAIM_VALIDATION_KEYS = [
  'contentClaim.errors.kind',
  'contentClaim.errors.contentUrlsRequired',
  'contentClaim.errors.contentUrlsTooMany',
  'contentClaim.errors.contentUrlInvalid',
  'contentClaim.errors.descriptionShort',
  'contentClaim.errors.descriptionLong',
  'contentClaim.errors.originalWorkUrl',
  'contentClaim.errors.name',
  'contentClaim.errors.email',
  'contentClaim.errors.organization',
  'contentClaim.errors.relationship',
  'contentClaim.errors.goodFaith',
  'contentClaim.errors.accurate',
  'contentClaim.errors.signature',
] as const;

export type ContentClaimValidationKey = (typeof CONTENT_CLAIM_VALIDATION_KEYS)[number];

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const httpsUrl = (message: ContentClaimValidationKey) =>
  z.string().trim().max(CONTENT_CLAIM_LIMITS.maxUrlLength, message).refine(isHttpsUrl, message);

/**
 * `POST /content-claims` — a claim, as the claimant sends it. Strict: an
 * unknown key is refused rather than dropped.
 */
export const contentClaimSubmissionSchema = z
  .object({
    kind: z.enum(CONTENT_CLAIM_KINDS, { message: 'contentClaim.errors.kind' }),
    contentUrls: z
      .array(httpsUrl('contentClaim.errors.contentUrlInvalid'), {
        message: 'contentClaim.errors.contentUrlsRequired',
      })
      .min(CONTENT_CLAIM_LIMITS.minUrls, 'contentClaim.errors.contentUrlsRequired')
      .max(CONTENT_CLAIM_LIMITS.maxUrls, 'contentClaim.errors.contentUrlsTooMany'),
    description: z
      .string({ message: 'contentClaim.errors.descriptionShort' })
      .trim()
      .min(CONTENT_CLAIM_LIMITS.minDescription, 'contentClaim.errors.descriptionShort')
      .max(CONTENT_CLAIM_LIMITS.maxDescription, 'contentClaim.errors.descriptionLong'),
    originalWorkUrl: httpsUrl('contentClaim.errors.originalWorkUrl').optional(),
    claimant: z
      .object(
        {
          name: z
            .string({ message: 'contentClaim.errors.name' })
            .trim()
            .min(1, 'contentClaim.errors.name')
            .max(CONTENT_CLAIM_LIMITS.maxName, 'contentClaim.errors.name'),
          email: z
            .string({ message: 'contentClaim.errors.email' })
            .trim()
            .email('contentClaim.errors.email')
            .max(CONTENT_CLAIM_LIMITS.maxEmail, 'contentClaim.errors.email'),
          organization: z
            .string({ message: 'contentClaim.errors.organization' })
            .trim()
            .max(CONTENT_CLAIM_LIMITS.maxOrganization, 'contentClaim.errors.organization')
            .optional(),
          relationship: z.enum(CLAIMANT_RELATIONSHIPS, {
            message: 'contentClaim.errors.relationship',
          }),
        },
        { message: 'contentClaim.errors.name' },
      )
      .strict(),
    statements: z
      .object(
        {
          goodFaith: z.literal(true, {
            errorMap: () => ({ message: 'contentClaim.errors.goodFaith' }),
          }),
          accurate: z.literal(true, {
            errorMap: () => ({ message: 'contentClaim.errors.accurate' }),
          }),
        },
        { message: 'contentClaim.errors.goodFaith' },
      )
      .strict(),
    signature: z
      .string({ message: 'contentClaim.errors.signature' })
      .trim()
      .min(1, 'contentClaim.errors.signature')
      .max(CONTENT_CLAIM_LIMITS.maxName, 'contentClaim.errors.signature'),
  })
  .strict();

export type ContentClaimSubmission = z.infer<typeof contentClaimSubmissionSchema>;

/** `201` to a submission: the claim's id and the reference the claimant quotes. */
export interface ContentClaimSubmissionResponse {
  id: string;
  /** e.g. `OXY-7K3M-9Q2D`: what the claimant quotes when writing about the claim. */
  reference: string;
}

/**
 * `400` to a submission: `error` is a sentence for the person, and `fields`
 * maps a body path (`claimant.email`, `contentUrls.3`) to a sentence about it.
 */
export interface ContentClaimSubmissionError {
  error: string;
  code: string;
  fields?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// The staff review (`/content-claims` behind the `content:claims` capability)
// ---------------------------------------------------------------------------

/** How a target's URL was understood. */
export const CONTENT_CLAIM_TARGET_RESOLUTIONS = [
  /** An Oxy file: `cloud.oxy.so/<id>`, `/cdn/<id>`, `/assets/<id>…`, a stored key. */
  'file',
  /** A page of an Oxy app or anything else: a person attaches the files it shows. */
  'unresolved',
] as const;

export type ContentClaimTargetResolution = (typeof CONTENT_CLAIM_TARGET_RESOLUTIONS)[number];

/** Who added a target: the claimant's URL, or staff attaching a file by id. */
export const CONTENT_CLAIM_TARGET_SOURCES = ['claimant', 'staff'] as const;

export type ContentClaimTargetSource = (typeof CONTENT_CLAIM_TARGET_SOURCES)[number];

/** What the audit trail records. */
export const CONTENT_CLAIM_EVENT_ACTIONS = [
  'submitted',
  'review_started',
  'targets_attached',
  'targets_blocked',
  'rejected',
  'counter_notice_recorded',
  /** The owner of the blocked content sent a counter-notice themselves (`POST /content-claims/counter-notices`). */
  'counter_notice_submitted',
  'reinstated',
  'upheld',
  'note_added',
] as const;

export type ContentClaimEventAction = (typeof CONTENT_CLAIM_EVENT_ACTIONS)[number];

/** One target as staff see it. */
export interface ContentClaimTargetView {
  id: string;
  source: ContentClaimTargetSource;
  url: string | null;
  resolution: ContentClaimTargetResolution;
  /** The file this target names, when it names one (null after the file's owner was deleted). */
  fileId: string | null;
  sha256: string | null;
  /** The file as it stands now, or null when there is no such row any more. */
  file: {
    id: string;
    status: 'active' | 'trash' | 'blocked' | 'lost' | 'deleted';
    visibility: 'private' | 'public' | 'unlisted';
    mime: string;
    size: number;
    ownerKind: 'account' | 'application' | 'platform';
    ownerUserId: string | null;
    ownerApplicationId: string | null;
  } | null;
  blockedAt: string | null;
  unblockedAt: string | null;
  createdAt: string;
}

/** One audit entry. */
export interface ContentClaimEventView {
  id: string;
  action: ContentClaimEventAction;
  /** The staff member (or the signed-in claimant, for `submitted`); null when anonymous or deleted. */
  actorUserId: string | null;
  fromState: ContentClaimState | null;
  toState: ContentClaimState | null;
  /** Free text staff wrote (a rejection reason, a counter-notice summary, a note). */
  note: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

/** A row of the queue. */
export interface ContentClaimSummaryView {
  id: string;
  reference: string;
  kind: ContentClaimKind;
  relationship: ClaimantRelationship;
  state: ContentClaimState;
  /** The statutory deadline (an erasure request), or null. */
  deadlineAt: string | null;
  targetCount: number;
  blockedTargetCount: number;
  receivedAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** A claim in full, for its detail page. */
export interface ContentClaimDetailView extends ContentClaimSummaryView {
  submittedByUserId: string | null;
  /** The claimant's statement; null once the retention period erased it. */
  claimant: {
    name: string;
    email: string;
    organization: string | null;
    signature: string;
    description: string;
    originalWorkUrl: string | null;
  } | null;
  /** When the claimant's statement is erased (set when the claim closes). */
  claimantExpiresAt: string | null;
  targets: ContentClaimTargetView[];
  events: ContentClaimEventView[];
  /** The owners' own counter-notices, oldest first. */
  counterNotices: ContentClaimCounterNoticeView[];
}

/** `GET /content-claims` */
export interface ContentClaimListResponse {
  claims: ContentClaimSummaryView[];
  /** Pass as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// The owner's counter-notice (`POST /content-claims/counter-notices`)
// ---------------------------------------------------------------------------

/** Every key a counter-notice's validation can produce, under `contentClaim.counterNotice.errors.*`. */
export const CONTENT_CLAIM_COUNTER_NOTICE_VALIDATION_KEYS = [
  'contentClaim.counterNotice.errors.claim',
  'contentClaim.counterNotice.errors.reference',
  'contentClaim.counterNotice.errors.claimId',
  'contentClaim.counterNotice.errors.fileIds',
  'contentClaim.counterNotice.errors.name',
  'contentClaim.counterNotice.errors.address',
  'contentClaim.counterNotice.errors.phone',
  'contentClaim.counterNotice.errors.email',
  'contentClaim.counterNotice.errors.materialDescription',
  'contentClaim.counterNotice.errors.materialLocation',
  'contentClaim.counterNotice.errors.explanation',
  'contentClaim.counterNotice.errors.perjury',
  'contentClaim.counterNotice.errors.jurisdiction',
  'contentClaim.counterNotice.errors.serviceOfProcess',
  'contentClaim.counterNotice.errors.disclosure',
  'contentClaim.counterNotice.errors.signature',
] as const;

export type ContentClaimCounterNoticeValidationKey =
  (typeof CONTENT_CLAIM_COUNTER_NOTICE_VALIDATION_KEYS)[number];

const N = CONTENT_CLAIM_COUNTER_NOTICE_LIMITS;

const boundedText = (min: number, max: number, message: ContentClaimCounterNoticeValidationKey) =>
  z.string({ message }).trim().min(min, message).max(max, message);

const affirmed = (message: ContentClaimCounterNoticeValidationKey) =>
  z.literal(true, { errorMap: () => ({ message }) });

/**
 * `POST /content-claims/counter-notices` — the owner of content a claim took
 * down disputes it (17 U.S.C. § 512(g)(3)). Signed in: the API answers only
 * for files the caller owns.
 *
 * Names the claim by its `reference` (the `OXY-XXXX-XXXX` the owner was
 * emailed), its `claimId`, or the blocked `fileIds` — at least one. With
 * `fileIds` the notice covers exactly those files; without, every one of the
 * caller's files the claim blocked. Strict: an unknown key is refused.
 */
export const contentClaimCounterNoticeSchema = z
  .object({
    reference: z
      .string({ message: 'contentClaim.counterNotice.errors.reference' })
      .trim()
      .toUpperCase()
      .regex(CONTENT_CLAIM_REFERENCE_PATTERN, 'contentClaim.counterNotice.errors.reference')
      .optional(),
    claimId: z
      .string({ message: 'contentClaim.counterNotice.errors.claimId' })
      .trim()
      .uuid('contentClaim.counterNotice.errors.claimId')
      .optional(),
    fileIds: z
      .array(boundedText(1, N.maxFileId, 'contentClaim.counterNotice.errors.fileIds'), {
        message: 'contentClaim.counterNotice.errors.fileIds',
      })
      .min(1, 'contentClaim.counterNotice.errors.fileIds')
      .max(N.maxFileIds, 'contentClaim.counterNotice.errors.fileIds')
      .optional(),
    subscriber: z
      .object(
        {
          name: boundedText(1, N.maxName, 'contentClaim.counterNotice.errors.name'),
          address: boundedText(1, N.maxAddress, 'contentClaim.counterNotice.errors.address'),
          phone: boundedText(
            N.minPhone,
            N.maxPhone,
            'contentClaim.counterNotice.errors.phone',
          ).regex(/^\+?[0-9 ().-]+$/, 'contentClaim.counterNotice.errors.phone'),
          email: z
            .string({ message: 'contentClaim.counterNotice.errors.email' })
            .trim()
            .email('contentClaim.counterNotice.errors.email')
            .max(N.maxEmail, 'contentClaim.counterNotice.errors.email'),
        },
        { message: 'contentClaim.counterNotice.errors.name' },
      )
      .strict(),
    material: z
      .object(
        {
          /** What was removed. */
          description: boundedText(
            N.minMaterial,
            N.maxMaterial,
            'contentClaim.counterNotice.errors.materialDescription',
          ),
          /** Where it appeared before it was removed (a URL, or where in an app). */
          location: boundedText(
            1,
            N.maxLocation,
            'contentClaim.counterNotice.errors.materialLocation',
          ),
        },
        { message: 'contentClaim.counterNotice.errors.materialDescription' },
      )
      .strict(),
    /** Why it was a mistake or a misidentification, in the owner's words. */
    explanation: boundedText(
      N.minExplanation,
      N.maxExplanation,
      'contentClaim.counterNotice.errors.explanation',
    ),
    /** Each of `COUNTER_NOTICE_STATEMENTS`, affirmed. */
    statements: z
      .object(
        {
          perjury: affirmed('contentClaim.counterNotice.errors.perjury'),
          jurisdiction: affirmed('contentClaim.counterNotice.errors.jurisdiction'),
          serviceOfProcess: affirmed('contentClaim.counterNotice.errors.serviceOfProcess'),
          disclosure: affirmed('contentClaim.counterNotice.errors.disclosure'),
        },
        { message: 'contentClaim.counterNotice.errors.perjury' },
      )
      .strict(),
    /** The owner's full legal name, typed as their signature. */
    signature: boundedText(1, N.maxSignature, 'contentClaim.counterNotice.errors.signature'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.reference === undefined &&
      value.claimId === undefined &&
      value.fileIds === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reference'],
        message: 'contentClaim.counterNotice.errors.claim',
      });
    }
  });

export type ContentClaimCounterNotice = z.infer<typeof contentClaimCounterNoticeSchema>;

/** `201` to a counter-notice. */
export interface ContentClaimCounterNoticeResponse {
  /** The counter-notice's id. */
  id: string;
  /** The claim it answers, as the owner was emailed it. */
  reference: string;
  /** Where the claim is now: `counter_noticed`. */
  state: ContentClaimState;
  /** The caller's blocked files the notice covers. */
  fileIds: string[];
}

/**
 * `400` to a counter-notice: `{ error, code: CONTENT_CLAIM_COUNTER_NOTICE_INVALID,
 * fields }`, `fields` mapping each body path to a sentence.
 */
export type ContentClaimCounterNoticeError = ContentClaimSubmissionError;

/** An owner's counter-notice as staff see it on the claim. */
export interface ContentClaimCounterNoticeView {
  id: string;
  /** The account that sent it (null once that account is deleted). */
  submittedByUserId: string | null;
  fileIds: string[];
  /** Which wording of `COUNTER_NOTICE_STATEMENTS` was affirmed. */
  statementVersion: string;
  /** What the owner wrote; null once the retention period erased it. */
  statement: {
    name: string;
    address: string;
    phone: string;
    email: string;
    materialDescription: string;
    materialLocation: string;
    explanation: string;
    signature: string;
  } | null;
  createdAt: string;
}
