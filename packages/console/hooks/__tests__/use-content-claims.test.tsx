import type { PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ContentClaimDetailView } from '@oxy.so/contracts';

const makeRequest = jest.fn();

jest.mock('@oxy.so/services', () => ({
  useAuth: () => ({
    oxyServices: { request: makeRequest },
    isAuthenticated: true,
    isReady: true,
  }),
}));

import {
  contentClaimKeys,
  useBlockClaimTargets,
  useClaimTargetPreview,
  useContentClaim,
  useContentClaims,
  useContentClaimsAccess,
  useRejectClaim,
} from '../use-content-claims';
import { EMPTY_CLAIM_FILTERS } from '@/lib/content-claims';

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function claim(state: ContentClaimDetailView['state'] = 'reviewing'): ContentClaimDetailView {
  return {
    id: 'claim_1',
    reference: 'OXY-7K3M-9Q2D',
    kind: 'copyright',
    relationship: 'rights_holder',
    state,
    deadlineAt: null,
    targetCount: 1,
    blockedTargetCount: state === 'actioned' ? 1 : 0,
    receivedAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    closedAt: null,
    submittedByUserId: null,
    claimant: null,
    claimantExpiresAt: null,
    targets: [],
    events: [],
    counterNotices: [],
  };
}

beforeEach(() => {
  makeRequest.mockReset();
});

describe('content claim reads', () => {
  it('asks for access, the queue on the server cursor, and a claim — never through the HTTP cache', async () => {
    makeRequest.mockImplementation(
      (_method: string, url: string, params?: Record<string, unknown>) => {
        if (url === '/content-claims/access') return Promise.resolve({ canReview: true });
        if (url === '/content-claims') {
          return Promise.resolve(
            params?.cursor
              ? { claims: [], nextCursor: null }
              : { claims: [claim()], nextCursor: 'cur_2' },
          );
        }
        return Promise.resolve(claim());
      },
    );
    const { wrapper } = harness();

    const access = renderHook(() => useContentClaimsAccess(), { wrapper });
    const queue = renderHook(
      () => useContentClaims({ ...EMPTY_CLAIM_FILTERS, states: ['received', 'reviewing'] }),
      { wrapper },
    );
    const detail = renderHook(() => useContentClaim('claim_1'), { wrapper });

    await waitFor(() => expect(access.result.current.data).toEqual({ canReview: true }));
    await waitFor(() => expect(queue.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));
    expect(queue.result.current.hasNextPage).toBe(true);

    await act(async () => {
      await queue.result.current.fetchNextPage();
    });
    expect(makeRequest).toHaveBeenCalledWith(
      'GET',
      '/content-claims',
      { limit: 50, state: 'received,reviewing' },
      { cache: false },
    );
    expect(makeRequest).toHaveBeenCalledWith(
      'GET',
      '/content-claims',
      { limit: 50, state: 'received,reviewing', cursor: 'cur_2' },
      { cache: false },
    );
    expect(makeRequest).toHaveBeenCalledWith('GET', '/content-claims/claim_1', undefined, {
      cache: false,
    });
  });

  it('does not retry a refusal: a 403 is shown as one', async () => {
    makeRequest.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    const { wrapper } = harness();
    const detail = renderHook(() => useContentClaim('claim_1'), { wrapper });
    await waitFor(() => expect(detail.result.current.isError).toBe(true));
    expect(makeRequest).toHaveBeenCalledTimes(1);
  });
});

describe('content claim actions', () => {
  it('writes the answered claim into the detail cache and refreshes the queue', async () => {
    const actioned = claim('actioned');
    makeRequest.mockResolvedValue({
      targetsBlocked: 1,
      hashesBlocked: 1,
      filesBlocked: 3,
      ownersNotified: 2,
      claim: actioned,
    });
    const { queryClient, wrapper } = harness();
    queryClient.setQueryData(contentClaimKeys.detail('claim_1'), claim('reviewing'));
    queryClient.setQueryData(contentClaimKeys.list(EMPTY_CLAIM_FILTERS), {
      pages: [{ claims: [], nextCursor: null }],
      pageParams: [null],
    });

    const block = renderHook(() => useBlockClaimTargets('claim_1'), { wrapper });
    await act(async () => {
      await block.result.current.mutateAsync({ targetIds: ['t1'], note: 'DMCA notice checked' });
    });

    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/content-claims/claim_1/block',
      { targetIds: ['t1'], note: 'DMCA notice checked' },
      { retry: false, deduplicate: false },
    );
    expect(queryClient.getQueryData(contentClaimKeys.detail('claim_1'))).toEqual(actioned);
    expect(
      queryClient.getQueryState(contentClaimKeys.list(EMPTY_CLAIM_FILTERS))?.isInvalidated,
    ).toBe(true);
  });

  it('accepts an action that answers the claim itself (a rejection)', async () => {
    const rejected = { ...claim('reviewing'), state: 'rejected' as const };
    makeRequest.mockResolvedValue(rejected);
    const { queryClient, wrapper } = harness();
    const reject = renderHook(() => useRejectClaim('claim_1'), { wrapper });
    await act(async () => {
      await reject.result.current.mutateAsync({ reason: 'Not an Oxy file' });
    });
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/content-claims/claim_1/reject',
      { reason: 'Not an Oxy file' },
      { retry: false, deduplicate: false },
    );
    expect(queryClient.getQueryData(contentClaimKeys.detail('claim_1'))).toEqual(rejected);
  });

  it('mints a preview link on demand and caches nothing of it', async () => {
    makeRequest.mockResolvedValue({
      url: 'https://api.oxy.so/content-claims/claim_1/targets/t1/content?pt=x',
      expiresAt: '2026-10-16T00:05:00.000Z',
    });
    const { queryClient, wrapper } = harness();
    const preview = renderHook(() => useClaimTargetPreview('claim_1'), { wrapper });
    await act(async () => {
      await preview.result.current.mutateAsync('t1');
    });
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/content-claims/claim_1/targets/t1/preview',
      {},
      { retry: false, deduplicate: false },
    );
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
  });
});
