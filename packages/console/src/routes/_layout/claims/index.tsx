import { Link, createFileRoute } from '@tanstack/react-router';
import { type ReactNode, useMemo, useState } from 'react';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ClaimDeadlineBadge,
  ClaimStateBadge,
  ClaimsRefusal,
} from '@/components/claims/claim-badges';
import { useContentClaims, useContentClaimsAccess } from '@/hooks/use-content-claims';
import { isPermissionRefused } from '@/lib/api-error';
import {
  CLAIM_KIND_LABELS,
  CLAIM_STATE_LABELS,
  CONTENT_CLAIM_KINDS,
  CONTENT_CLAIM_STATES,
  type ContentClaimFilters,
  EMPTY_CLAIM_FILTERS,
  toggleFilterValue,
} from '@/lib/content-claims';

/**
 * The content-claim queue (ADR 0042 D10): what people reported through
 * oxy.so's "Report content" page, for the staff who hold `content:claims`.
 *
 * Newest first; the deadline filters list only OPEN erasure requests, soonest
 * due first — the order the API returns, which this page never re-sorts.
 */
export const Route = createFileRoute('/_layout/claims/')({
  component: ContentClaimsQueuePage,
});

const DEADLINE_FILTERS = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'due_soon', label: 'Due within 7 days' },
  { value: 'any', label: 'Any erasure request' },
] as const;

/** Open claims are what a reviewer works through; the filter starts there. */
const INITIAL_FILTERS: ContentClaimFilters = {
  ...EMPTY_CLAIM_FILTERS,
  states: ['received', 'reviewing', 'actioned', 'counter_noticed'],
};

function ContentClaimsQueuePage() {
  const access = useContentClaimsAccess();
  const [filters, setFilters] = useState<ContentClaimFilters>(INITIAL_FILTERS);
  const canReview = access.data?.canReview === true;
  const query = useContentClaims(filters, canReview);
  const claims = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.claims),
    [query.data],
  );

  return (
    <ScrollArea className="flex-1 bg-background">
      <div className="px-6 pt-6 pb-4 border-b border-border">
        <h1 className="text-2xl font-semibold text-foreground">Content claims</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Rights, privacy and illegal-content reports sent through oxy.so. Blocking a claim's files
          takes those exact bytes down for every owner and refuses them on every future upload.
        </p>
      </div>

      {access.isLoading ? (
        <div className="px-6 py-8">
          <Skeleton.Box width="100%" height={64} />
        </div>
      ) : !canReview || (query.isError && isPermissionRefused(query.error)) ? (
        <ClaimsRefusal />
      ) : (
        <div className="px-6 py-6 space-y-4">
          <div className="space-y-2">
            <FilterRow label="State">
              {CONTENT_CLAIM_STATES.map((state) => (
                <FilterChip
                  key={state}
                  active={filters.states.includes(state)}
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      states: toggleFilterValue(current.states, state),
                    }))
                  }
                >
                  {CLAIM_STATE_LABELS[state]}
                </FilterChip>
              ))}
            </FilterRow>
            <FilterRow label="Kind">
              {CONTENT_CLAIM_KINDS.map((kind) => (
                <FilterChip
                  key={kind}
                  active={filters.kinds.includes(kind)}
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      kinds: toggleFilterValue(current.kinds, kind),
                    }))
                  }
                >
                  {CLAIM_KIND_LABELS[kind]}
                </FilterChip>
              ))}
            </FilterRow>
            <FilterRow label="Deadline">
              {DEADLINE_FILTERS.map((option) => (
                <FilterChip
                  key={option.value}
                  active={filters.deadline === option.value}
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      deadline: current.deadline === option.value ? null : option.value,
                    }))
                  }
                >
                  {option.label}
                </FilterChip>
              ))}
            </FilterRow>
          </div>

          {query.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((row) => (
                <Skeleton.Box key={row} width="100%" height={44} />
              ))}
            </div>
          ) : query.isError ? (
            <p className="text-sm text-muted-foreground">The claims could not be loaded.</p>
          ) : claims.length === 0 ? (
            <p className="text-sm text-muted-foreground">No claims match these filters.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left">
                    <th className="px-4 py-2 font-medium text-muted-foreground">Reference</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">Kind</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">State</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">Received</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">Deadline</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">Blocked</th>
                  </tr>
                </thead>
                <tbody>
                  {claims.map((claim) => (
                    <tr key={claim.id} className="border-b border-border last:border-0 align-top">
                      <td className="px-4 py-2">
                        <Link
                          to="/claims/$claimId"
                          params={{ claimId: claim.id }}
                          className="font-mono text-foreground underline underline-offset-4"
                        >
                          {claim.reference}
                        </Link>
                      </td>
                      <td className="px-4 py-2">{CLAIM_KIND_LABELS[claim.kind]}</td>
                      <td className="px-4 py-2">
                        <ClaimStateBadge state={claim.state} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                        {new Date(claim.receivedAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2">
                        <ClaimDeadlineBadge claim={claim} />
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {claim.blockedTargetCount} of {claim.targetCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {query.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </div>
      )}
    </ScrollArea>
  );
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-20 text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="xs"
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
