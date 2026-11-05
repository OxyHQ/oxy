import { getAccountFallbackHandle } from '@oxy.so/core';
import { useAuth } from '@oxy.so/services/ui/client';
import { useQuery } from '@tanstack/react-query';

export interface MemberProfile {
  name?: string;
  handle?: string;
}

/**
 * Names for a workspace's members, one batch read (`users.lookupMany`). Rows show the id
 * until it answers, and keep showing it for anyone the read could not resolve.
 */
export function useMemberProfiles(userIds: ReadonlyArray<string>): Map<string, MemberProfile> {
  const { oxyServices, isAuthenticated, isReady } = useAuth();
  const ids = [...new Set(userIds)].sort();
  const query = useQuery({
    queryKey: ['member-profiles', ids],
    queryFn: async () => {
      // `lookupMany`, not `getMany`: a failed chunk is unknown, not absent, so
      // the query fails and is retried instead of caching ids as nameless for
      // the ten-minute stale window.
      const lookup = await oxyServices.users.lookupMany(ids);
      if (lookup.failed.length > 0) throw lookup.error ?? new Error('Member profiles unavailable');
      const users = lookup.found;
      return new Map<string, MemberProfile>(
        users.map((user) => [
          user.id,
          { name: user.name?.displayName, handle: getAccountFallbackHandle(user) ?? undefined },
        ]),
      );
    },
    enabled: isReady && isAuthenticated && ids.length > 0,
    staleTime: 1000 * 60 * 10,
  });
  return query.data ?? new Map();
}
