import {
  CONTENT_CLAIM_KINDS,
  CONTENT_CLAIM_STATES,
  OPEN_CONTENT_CLAIM_STATES,
  type ClaimantRelationship,
  type ContentClaimEventAction,
  type ContentClaimKind,
  type ContentClaimState,
  type ContentClaimTargetResolution,
  type ContentClaimTargetView,
} from '@oxy.so/contracts';

/**
 * The staff review of content claims (ADR 0043 D10), as pure rules.
 *
 * The API is the authority on every transition — each is a conditional write
 * that answers 409 `CONTENT_CLAIM_STATE_CONFLICT` when the claim moved on — so
 * these only decide which buttons a reviewer is OFFERED. They mirror the
 * server's state machine exactly:
 *
 *   received → reviewing → actioned | rejected
 *   received → rejected
 *   actioned → counter_noticed → reinstated | upheld
 */

export { CONTENT_CLAIM_KINDS, CONTENT_CLAIM_STATES };

/** Days before an erasure deadline the queue calls it "due soon" (the API's own window). */
export const DUE_SOON_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isOpenClaimState(state: ContentClaimState): boolean {
  return (OPEN_CONTENT_CLAIM_STATES as readonly ContentClaimState[]).includes(state);
}

export const canStartReview = (state: ContentClaimState): boolean => state === 'received';

/** Blocking: the first block moves `reviewing → actioned`; more may follow while actioned. */
export const canBlock = (state: ContentClaimState): boolean =>
  state === 'reviewing' || state === 'actioned';

export const canReject = (state: ContentClaimState): boolean =>
  state === 'received' || state === 'reviewing';

export const canRecordCounterNotice = (state: ContentClaimState): boolean => state === 'actioned';

export const canReinstate = (state: ContentClaimState): boolean => state === 'counter_noticed';

export const canUphold = (state: ContentClaimState): boolean => state === 'counter_noticed';

/** Files can be attached while the claim can still lead to a block. */
export const canAttach = (state: ContentClaimState): boolean =>
  state === 'received' || state === 'reviewing' || state === 'actioned';

/** A target staff may select for a block: it names bytes and is not blocked yet. */
export function isBlockableTarget(target: ContentClaimTargetView): boolean {
  return target.resolution === 'file' && target.sha256 !== null && target.blockedAt === null;
}

export type DeadlineStatus = 'none' | 'ok' | 'due_soon' | 'overdue';

/**
 * Where a claim stands against its statutory deadline (an erasure request's
 * one month). A closed claim has answered it, so it reads `none` like a claim
 * without one.
 */
export function deadlineStatus(
  claim: { deadlineAt: string | null; state: ContentClaimState },
  now: Date = new Date(),
): DeadlineStatus {
  if (claim.deadlineAt === null || !isOpenClaimState(claim.state)) return 'none';
  const due = new Date(claim.deadlineAt).getTime();
  if (due < now.getTime()) return 'overdue';
  if (due <= now.getTime() + DUE_SOON_DAYS * DAY_MS) return 'due_soon';
  return 'ok';
}

/** The badge style a state reads in. */
export function claimStateVariant(
  state: ContentClaimState,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (state) {
    case 'received':
    case 'counter_noticed':
      return 'default';
    case 'reviewing':
      return 'secondary';
    case 'actioned':
    case 'upheld':
      return 'destructive';
    case 'rejected':
    case 'reinstated':
      return 'outline';
  }
}

/** The queue's filters, as the page holds them. */
export interface ContentClaimFilters {
  states: ContentClaimState[];
  kinds: ContentClaimKind[];
  /** Only open erasure requests: past due, due soon, or any of them. */
  deadline: 'overdue' | 'due_soon' | 'any' | null;
}

export const EMPTY_CLAIM_FILTERS: ContentClaimFilters = { states: [], kinds: [], deadline: null };

/** The query parameters `GET /content-claims` takes for these filters (empty ones omitted). */
export function claimQueryParams(
  filters: ContentClaimFilters,
  cursor: string | null = null,
  limit = 50,
): Record<string, string | number> {
  return {
    limit,
    ...(filters.states.length > 0 ? { state: filters.states.join(',') } : {}),
    ...(filters.kinds.length > 0 ? { kind: filters.kinds.join(',') } : {}),
    ...(filters.deadline ? { deadline: filters.deadline } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/** Add or remove one value from a filter list, keeping the list's order stable. */
export function toggleFilterValue<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

/** File ids typed into the attach form: commas, spaces or new lines between them; repeats dropped. */
export function parseFileIds(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

/** How a preview is shown: inline for images and videos, a link for anything else. */
export function previewKind(mime: string | undefined): 'image' | 'video' | 'link' {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  return 'link';
}
