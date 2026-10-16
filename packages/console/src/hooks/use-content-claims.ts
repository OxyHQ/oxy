import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services';
import type { ContentClaimDetailView, ContentClaimListResponse } from '@oxy.so/contracts';
import { isPermissionRefused } from '@/lib/api-error';
import { type ContentClaimFilters, claimQueryParams } from '@/lib/content-claims';

// ===========================================================================
// The content-claim review (`/content-claims`, ADR 0041 D10), staff only.
//
// Every route behind it requires the `content:claims` staff capability, so the
// page first asks `/content-claims/access` (which answers anyone signed in) and
// renders a refusal rather than a spinner. A claim carries the claimant's name,
// email and statement: reads are `cache: false` so the HTTP layer keeps no copy
// beyond React Query's own, and nothing here is persisted.
//
// Each action answers the claim as it now stands (directly, or as `claim` beside
// its result), which is written straight into the detail cache; the queue is
// invalidated because the claim's state, and so its place in a filter, moved.
// ===========================================================================

export const contentClaimKeys = {
  access: ['content-claims', 'access'] as const,
  lists: ['content-claims', 'list'] as const,
  list: (filters: ContentClaimFilters) => ['content-claims', 'list', filters] as const,
  detail: (claimId: string) => ['content-claims', 'detail', claimId] as const,
};

/** A refusal is an answer: retrying it only hides it behind a spinner. */
function retryUnlessRefused(failureCount: number, error: unknown): boolean {
  return !isPermissionRefused(error) && failureCount < 1;
}

/** Whether the signed-in account may review claims (`content:claims`). */
export function useContentClaimsAccess() {
  const { oxyServices, isAuthenticated, isReady } = useAuth();
  return useQuery({
    queryKey: contentClaimKeys.access,
    queryFn: () =>
      oxyServices.request<{ canReview: boolean }>('GET', '/content-claims/access', undefined, {
        cache: false,
      }),
    enabled: isReady && isAuthenticated,
    staleTime: 5 * 60_000,
    retry: retryUnlessRefused,
  });
}

/** The queue, page by page on the server's own cursor. */
export function useContentClaims(filters: ContentClaimFilters, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();
  return useInfiniteQuery({
    queryKey: contentClaimKeys.list(filters),
    queryFn: ({ pageParam }) =>
      oxyServices.request<ContentClaimListResponse>(
        'GET',
        '/content-claims',
        claimQueryParams(filters, pageParam),
        { cache: false },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: isReady && isAuthenticated && enabled,
    staleTime: 15_000,
    retry: retryUnlessRefused,
  });
}

/** One claim in full. */
export function useContentClaim(claimId: string | undefined, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();
  return useQuery({
    queryKey: contentClaimKeys.detail(claimId ?? ''),
    queryFn: () =>
      oxyServices.request<ContentClaimDetailView>(
        'GET',
        `/content-claims/${encodeURIComponent(claimId ?? '')}`,
        undefined,
        { cache: false },
      ),
    enabled: isReady && isAuthenticated && !!claimId && enabled,
    staleTime: 10_000,
    retry: retryUnlessRefused,
  });
}

/** What every action answers: the claim itself, or a result with the claim beside it. */
type ActionAnswer = ContentClaimDetailView | { claim: ContentClaimDetailView };

function claimOf(answer: ActionAnswer): ContentClaimDetailView {
  return 'claim' in answer ? answer.claim : answer;
}

/**
 * One action on a claim. Never retried and never deduplicated: each is a
 * state transition the server applies once, and a replay would answer 409.
 */
function useClaimAction<Variables, Answer extends ActionAnswer>(
  claimId: string,
  path: string,
  body: (variables: Variables) => Record<string, unknown> | undefined,
) {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: Variables) =>
      oxyServices.request<Answer>(
        'POST',
        `/content-claims/${encodeURIComponent(claimId)}${path}`,
        body(variables) ?? {},
        { retry: false, deduplicate: false },
      ),
    onSuccess: (answer) => {
      queryClient.setQueryData(contentClaimKeys.detail(claimId), claimOf(answer));
      queryClient.invalidateQueries({ queryKey: contentClaimKeys.lists });
    },
  });
}

/** `received → reviewing`. */
export function useStartClaimReview(claimId: string) {
  return useClaimAction<void, ContentClaimDetailView>(claimId, '/review', () => undefined);
}

/** Attach files by id (what a page URL shows). */
export function useAttachClaimTargets(claimId: string) {
  return useClaimAction<
    { fileIds: string[]; url?: string },
    { attached: string[]; alreadyAttached: string[]; claim: ContentClaimDetailView }
  >(claimId, '/targets', ({ fileIds, url }) => ({ fileIds, ...(url ? { url } : {}) }));
}

/** Block targets: these, or every unblocked file target when `targetIds` is absent. */
export function useBlockClaimTargets(claimId: string) {
  return useClaimAction<
    { targetIds?: string[]; note?: string },
    {
      targetsBlocked: number;
      hashesBlocked: number;
      filesBlocked: number;
      ownersNotified: number;
      claim: ContentClaimDetailView;
    }
  >(claimId, '/block', ({ targetIds, note }) => ({
    ...(targetIds ? { targetIds } : {}),
    ...(note ? { note } : {}),
  }));
}

/** `received | reviewing → rejected`; the reason is emailed to the claimant. */
export function useRejectClaim(claimId: string) {
  return useClaimAction<{ reason: string }, ContentClaimDetailView>(
    claimId,
    '/reject',
    ({ reason }) => ({ reason }),
  );
}

/** `actioned → counter_noticed`; the summary is emailed to the claimant. */
export function useRecordCounterNotice(claimId: string) {
  return useClaimAction<{ note: string }, ContentClaimDetailView>(
    claimId,
    '/counter-notice',
    ({ note }) => ({ note }),
  );
}

/** `counter_noticed → reinstated`: the claim's blocks are lifted. */
export function useReinstateClaim(claimId: string) {
  return useClaimAction<
    { note?: string },
    { filesRestored: number; claim: ContentClaimDetailView }
  >(claimId, '/reinstate', ({ note }) => (note ? { note } : {}));
}

/** `counter_noticed → upheld`: the blocks stand. */
export function useUpholdClaim(claimId: string) {
  return useClaimAction<{ note?: string }, ContentClaimDetailView>(
    claimId,
    '/uphold',
    ({ note }) => (note ? { note } : {}),
  );
}

/** A note on the audit trail. */
export function useAddClaimNote(claimId: string) {
  return useClaimAction<{ note: string }, ContentClaimDetailView>(
    claimId,
    '/notes',
    ({ note }) => ({ note }),
  );
}

/**
 * A short-lived URL to preview one target's file (5 minutes). Minted on
 * demand, never cached: the URL is itself the credential.
 */
export function useClaimTargetPreview(claimId: string) {
  const { oxyServices } = useAuth();
  return useMutation({
    mutationFn: (targetId: string) =>
      oxyServices.request<{ url: string; expiresAt: string }>(
        'POST',
        `/content-claims/${encodeURIComponent(claimId)}/targets/${encodeURIComponent(targetId)}/preview`,
        {},
        { retry: false, deduplicate: false },
      ),
  });
}
