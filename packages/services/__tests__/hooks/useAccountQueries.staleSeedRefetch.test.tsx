/**
 * `useUserByUsername` must honor the `upsertCachedUser` stale-seed contract
 * even under a consuming app's global `refetchOnMount: false`.
 *
 * `upsertCachedUser` seeds a COLD by-username slot from a sparse feed/post
 * author (no `createdAt`/`relationship`/`_count`) and marks it STALE
 * (`updatedAt: 0`) so the reading hook refetches the full authoritative
 * profile on mount. A consumer whose QueryClient sets
 * `defaultOptions.queries.refetchOnMount: false` (a common perf setting —
 * Mention does exactly this) would defeat that contract: the stale sparse seed
 * is served forever and the authoritative fetch (which carries `createdAt`)
 * never runs — the "Joined <date> missing depending on where you came from"
 * bug. `useUserByUsername` pins `refetchOnMount: true` locally so the seed is
 * always refetched; the 5m `staleTime` keeps a genuinely fresh entry from
 * refetching redundantly.
 */

import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { User } from '@oxy.so/core';
import { queryKeys } from '../../src/ui/hooks/queries/queryKeys';
import { useUserByUsername } from '../../src/ui/hooks/queries/useAccountQueries';

interface MockOxyServices {
  getUserById: jest.Mock;
  getProfileByUsername: jest.Mock;
}

interface MockOxyState {
  oxyServices: MockOxyServices;
  user: { id: string } | null;
}

/** What a feed/post hydration precache lands in the cache: NO `createdAt`. */
const SPARSE_SEED: User = {
  id: 'target-1',
  username: 'alice',
  name: { displayName: 'Alice' },
} as User;

/** What the authoritative single-profile fetch returns: carries `createdAt`. */
const FULL_PROFILE: User = {
  ...SPARSE_SEED,
  createdAt: '2021-05-01T00:00:00.000Z',
  relationship: { isFollowing: false, followsYou: true },
} as User;

let mockState: MockOxyState;

jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => mockState,
}));

const makeWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

describe('useUserByUsername stale-seed refetch under refetchOnMount:false', () => {
  it('refetches the sparse {updatedAt:0} seed on mount and fills createdAt', async () => {
    const getProfileByUsername = jest.fn(async () => FULL_PROFILE);
    mockState = {
      oxyServices: {
        getUserById: jest.fn(async () => SPARSE_SEED),
        getProfileByUsername,
      },
      // Anonymous viewer — the by-username key's viewer scope is '' here, which
      // is exactly where a pre-session precache seeds.
      user: null,
    };

    // A consumer QueryClient that NEVER refetches stale cache on mount by
    // default (Mention's real setting) with the SDK's own 5m staleTime.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 5 * 60 * 1000,
          refetchOnMount: false,
        },
      },
    });

    // Precache the sparse author into the EXACT key the hook reads, marked STALE
    // — mirrors upsertCachedUser seeding a cold slot from a feed author.
    queryClient.setQueryData(queryKeys.users.byUsername('alice', ''), SPARSE_SEED, {
      updatedAt: 0,
    });

    const { result } = renderHook(() => useUserByUsername('alice'), {
      wrapper: makeWrapper(queryClient),
    });

    // Despite the client-level refetchOnMount:false, the hook's local
    // refetchOnMount:true refetches the stale seed and fills createdAt.
    await waitFor(() =>
      expect((result.current.data as User | undefined)?.createdAt).toBe(FULL_PROFILE.createdAt),
    );
    expect(getProfileByUsername).toHaveBeenCalledTimes(1);
    expect(getProfileByUsername).toHaveBeenCalledWith('alice');
    expect(queryClient.getQueryData(queryKeys.users.byUsername('alice', ''))).toEqual(FULL_PROFILE);
  });

  it('control: a fresh (recently-fetched) seed is NOT refetched — staleTime protects it', async () => {
    const getProfileByUsername = jest.fn(async () => FULL_PROFILE);
    mockState = {
      oxyServices: {
        getUserById: jest.fn(async () => SPARSE_SEED),
        getProfileByUsername,
      },
      user: null,
    };

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 5 * 60 * 1000,
          refetchOnMount: false,
        },
      },
    });

    // Seed the SAME sparse object but mark it FRESH (fetched just now). Because
    // it is inside the 5m staleTime window, refetchOnMount:true is a no-op —
    // proving the override only refetches STALE seeds, never fresh entries (so
    // no redundant refetch for a profile that just came from the real fetch).
    queryClient.setQueryData(queryKeys.users.byUsername('alice', ''), SPARSE_SEED, {
      updatedAt: Date.now(),
    });

    renderHook(() => useUserByUsername('alice'), {
      wrapper: makeWrapper(queryClient),
    });

    // Give any pending microtask/refetch a chance to fire, then assert none did.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getProfileByUsername).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.users.byUsername('alice', ''))).toEqual(SPARSE_SEED);
  });
});
