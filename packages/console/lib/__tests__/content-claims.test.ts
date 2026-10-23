import type { ContentClaimState, ContentClaimTargetView } from '@oxy.so/contracts';
import {
  CONTENT_CLAIM_STATES,
  EMPTY_CLAIM_FILTERS,
  canAttach,
  canBlock,
  canRecordCounterNotice,
  canReinstate,
  canReject,
  canStartReview,
  canUphold,
  claimQueryParams,
  deadlineStatus,
  isBlockableTarget,
  isOpenClaimState,
  parseFileIds,
  previewKind,
  toggleFilterValue,
} from '../content-claims';

/** The server's state machine, written out once so every predicate is checked against it. */
const OFFERED: Record<ContentClaimState, string[]> = {
  received: ['review', 'reject', 'attach'],
  reviewing: ['block', 'reject', 'attach'],
  actioned: ['block', 'counter', 'attach'],
  rejected: [],
  counter_noticed: ['reinstate', 'uphold'],
  reinstated: [],
  upheld: [],
};

function offered(state: ContentClaimState): string[] {
  return [
    canStartReview(state) && 'review',
    canBlock(state) && 'block',
    canReject(state) && 'reject',
    canRecordCounterNotice(state) && 'counter',
    canReinstate(state) && 'reinstate',
    canUphold(state) && 'uphold',
    canAttach(state) && 'attach',
  ]
    .filter((value): value is string => typeof value === 'string')
    .sort();
}

describe('content claim actions', () => {
  it.each(CONTENT_CLAIM_STATES)('offers exactly what the API allows from %s', (state) => {
    expect(offered(state)).toEqual([...OFFERED[state]].sort());
  });

  it('calls only the four non-final states open', () => {
    expect(CONTENT_CLAIM_STATES.filter(isOpenClaimState)).toEqual([
      'received',
      'reviewing',
      'actioned',
      'counter_noticed',
    ]);
  });
});

describe('deadlineStatus', () => {
  const now = new Date('2026-10-16T12:00:00.000Z');
  const at = (days: number) => new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  it('reads overdue, due soon (7 days) and ok for an open claim', () => {
    expect(deadlineStatus({ deadlineAt: at(-1), state: 'reviewing' }, now)).toBe('overdue');
    expect(deadlineStatus({ deadlineAt: at(6.9), state: 'received' }, now)).toBe('due_soon');
    expect(deadlineStatus({ deadlineAt: at(7), state: 'received' }, now)).toBe('due_soon');
    expect(deadlineStatus({ deadlineAt: at(8), state: 'received' }, now)).toBe('ok');
  });

  it('is none without a deadline, and none once the claim is closed', () => {
    expect(deadlineStatus({ deadlineAt: null, state: 'received' }, now)).toBe('none');
    expect(deadlineStatus({ deadlineAt: at(-10), state: 'rejected' }, now)).toBe('none');
    expect(deadlineStatus({ deadlineAt: at(-10), state: 'upheld' }, now)).toBe('none');
  });
});

describe('claimQueryParams', () => {
  it('omits empty filters and joins lists with commas', () => {
    expect(claimQueryParams(EMPTY_CLAIM_FILTERS)).toEqual({ limit: 50 });
    expect(
      claimQueryParams(
        { states: ['received', 'reviewing'], kinds: ['privacy'], deadline: 'overdue' },
        'cur_1',
        20,
      ),
    ).toEqual({
      limit: 20,
      state: 'received,reviewing',
      kind: 'privacy',
      deadline: 'overdue',
      cursor: 'cur_1',
    });
  });

  it('toggles a filter value in place', () => {
    expect(toggleFilterValue(['received'], 'reviewing')).toEqual(['received', 'reviewing']);
    expect(toggleFilterValue(['received', 'reviewing'], 'received')).toEqual(['reviewing']);
  });
});

describe('form helpers', () => {
  it('parses file ids separated by commas, spaces and lines, once each', () => {
    expect(parseFileIds(' a1, b2\nc3  a1\n\n')).toEqual(['a1', 'b2', 'c3']);
    expect(parseFileIds('   ')).toEqual([]);
  });

  it('previews images and videos inline and anything else as a link', () => {
    expect(previewKind('image/png')).toBe('image');
    expect(previewKind('video/mp4')).toBe('video');
    expect(previewKind('application/pdf')).toBe('link');
    expect(previewKind(undefined)).toBe('link');
  });

  it('offers to block only an unblocked target that names bytes', () => {
    const base: ContentClaimTargetView = {
      id: 't1',
      source: 'claimant',
      url: 'https://cloud.oxy.so/f1',
      resolution: 'file',
      fileId: 'f1',
      sha256: 'a'.repeat(64),
      file: null,
      blockedAt: null,
      unblockedAt: null,
      createdAt: '2026-10-16T00:00:00.000Z',
    };
    expect(isBlockableTarget(base)).toBe(true);
    expect(isBlockableTarget({ ...base, blockedAt: '2026-10-16T01:00:00.000Z' })).toBe(false);
    expect(
      isBlockableTarget({ ...base, resolution: 'unresolved', fileId: null, sha256: null }),
    ).toBe(false);
  });
});
