import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services';
import type { Channel, Update, UpdatePlatform } from '@oxy.so/contracts';

// ===========================================================================
// Oxy Updates (self-hosted expo-updates) — console admin hooks.
//
// The Updates admin API (`/updates/v1/...` on api.oxy.so) is NOT an
// `@oxy.so/core` mixin, so — like the billing/models hooks — these call it
// through `oxyServices.makeRequest`, which unwraps the standard `{ data }`
// envelope and keeps the bearer token in lockstep with the active session.
// Wire types come from `@oxy.so/contracts` (the single source of truth the API
// validates its output against), so producer and consumer cannot drift.
//
// Every endpoint requires the `updates:manage` application permission (owner /
// admin / developer roles). Callers gate the UI on that permission before
// enabling these queries so viewers never hit a guaranteed 403.
// ===========================================================================

export type { Channel, Update, UpdatePlatform };

const UPDATES_BASE = '/updates/v1';

const queryKeys = {
  /** All channels for an application. */
  channels: (appId: string) => ['update-channels', appId] as const,
  /** All updates in one channel (grouped into heads client-side). */
  channelUpdates: (appId: string, channel: string) =>
    ['update-channel-updates', appId, channel] as const,
};

/** Prefix matching every channel-updates query for an app (for invalidation). */
const channelUpdatesPrefix = (appId: string) => ['update-channel-updates', appId] as const;

// ===========================================================================
// Queries
// ===========================================================================

/** List the release channels for an application (e.g. production, preview, pr-123). */
export function useUpdateChannels(appId: string, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.channels(appId),
    queryFn: () =>
      oxyServices
        .makeRequest<{ channels: Array<Channel> }>('GET', `${UPDATES_BASE}/channels`, {
          applicationId: appId,
        })
        .then((result) => result.channels),
    enabled: isReady && isAuthenticated && !!appId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

/**
 * List the updates published to a single channel (newest first, all statuses).
 * The console groups them into per-(runtimeVersion × platform) heads.
 */
export function useChannelUpdates(appId: string, channel: string, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.channelUpdates(appId, channel),
    queryFn: () =>
      oxyServices
        .makeRequest<{ updates: Array<Update> }>(
          'GET',
          `${UPDATES_BASE}/channels/${encodeURIComponent(channel)}/updates`,
          { applicationId: appId, limit: 200 }
        )
        .then((result) => result.updates),
    enabled: isReady && isAuthenticated && !!appId && !!channel && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

// ===========================================================================
// Mutations
//
// Writes affect the head of a (channel, runtimeVersion, platform) tuple, and
// promote can even create/target a different channel — so each invalidates the
// channels list AND every channel-updates query for the app rather than trying
// to patch one cached list.
// ===========================================================================

function useInvalidateUpdates(appId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.channels(appId) });
    queryClient.invalidateQueries({ queryKey: channelUpdatesPrefix(appId) });
  };
}

export interface PromoteUpdateInput {
  /** Source channel the update currently lives in (path parameter). */
  channel: string;
  /** The update (UUID) to promote. */
  updateId: string;
  /** Target channel to promote into. Defaults server-side to `channel`. */
  toChannel?: string;
  /** Rollout percentage for the promoted update (default 100). */
  rolloutPercent?: number;
}

export function usePromoteUpdate(appId: string) {
  const { oxyServices } = useAuth();
  const invalidate = useInvalidateUpdates(appId);

  return useMutation({
    mutationFn: ({ channel, updateId, toChannel, rolloutPercent }: PromoteUpdateInput) =>
      oxyServices
        .makeRequest<{ update: Update }>(
          'POST',
          `${UPDATES_BASE}/channels/${encodeURIComponent(channel)}/promote`,
          { applicationId: appId, updateId, toChannel, rolloutPercent }
        )
        .then((result) => result.update),
    onSuccess: invalidate,
  });
}

export interface ChannelTargetInput {
  channel: string;
  runtimeVersion: string;
  platform: UpdatePlatform;
}

export function useRollbackChannel(appId: string) {
  const { oxyServices } = useAuth();
  const invalidate = useInvalidateUpdates(appId);

  return useMutation({
    mutationFn: ({ channel, runtimeVersion, platform }: ChannelTargetInput) =>
      oxyServices.makeRequest<{ rolledBack: Update; head: Update | null }>(
        'POST',
        `${UPDATES_BASE}/channels/${encodeURIComponent(channel)}/rollback`,
        { applicationId: appId, runtimeVersion, platform }
      ),
    onSuccess: invalidate,
  });
}

export function useRollbackToEmbedded(appId: string) {
  const { oxyServices } = useAuth();
  const invalidate = useInvalidateUpdates(appId);

  return useMutation({
    mutationFn: ({ channel, runtimeVersion, platform }: ChannelTargetInput) =>
      oxyServices
        .makeRequest<{ channel: Channel }>(
          'POST',
          `${UPDATES_BASE}/channels/${encodeURIComponent(channel)}/rollback-to-embedded`,
          { applicationId: appId, runtimeVersion, platform }
        )
        .then((result) => result.channel),
    onSuccess: invalidate,
  });
}

export interface SetRolloutInput {
  updateId: string;
  rolloutPercent: number;
}

export function useSetRollout(appId: string) {
  const { oxyServices } = useAuth();
  const invalidate = useInvalidateUpdates(appId);

  return useMutation({
    mutationFn: ({ updateId, rolloutPercent }: SetRolloutInput) =>
      oxyServices
        .makeRequest<{ update: Update }>(
          'PATCH',
          `${UPDATES_BASE}/updates/${encodeURIComponent(updateId)}`,
          { applicationId: appId, rolloutPercent }
        )
        .then((result) => result.update),
    onSuccess: invalidate,
  });
}
