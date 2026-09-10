import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@oxy.so/bloom';
import { useOxy, useFollow, usePrivacySettings, useUpdatePrivacySettings } from '@oxy.so/services';
import { useTranslation } from '@/lib/i18n';

export interface UsePrivacyCountsArgs {
  userId: string | undefined;
}

export interface UsePrivacyCountsResult {
  followerCount: number | null | undefined;
  followingCount: number | null | undefined;
  blockedCount: number;
  restrictedCount: number;
  profileVisibility: boolean;
  locationSharing: boolean;
  pendingPrivacyKey: string | null;
  handlePrivacyUpdate: (key: string, value: boolean) => Promise<void>;
  refreshing: boolean;
  privacyLoading: boolean;
  privacyFetching: boolean;
  handleRefresh: () => Promise<void>;
}

/**
 * Owns the People & Sharing screen's privacy state:
 *   - follower/following counts (via `useFollow`)
 *   - blocked/restricted user counts (via the core SDK)
 *   - the privacy-settings query and its derived toggles
 *     (`profileVisibility`, `locationSharing`)
 *   - the toggle mutation handler with per-key pending tracking
 *   - pull-to-refresh orchestration across all of the above.
 *
 * Extracted verbatim from the screen; the count-refresh effect keys on the
 * active user id via a ref so an in-flight fetch for a previous account can
 * never write stale counts after an account switch.
 */
export function usePrivacyCounts({ userId }: UsePrivacyCountsArgs): UsePrivacyCountsResult {
  const { oxyServices } = useOxy();
  const { t } = useTranslation();

  // Fetch follower/following counts
  const { followerCount, followingCount, fetchUserCounts } = useFollow(userId);

  // Privacy settings via react-query hooks (same pattern as data.tsx)
  const {
    data: privacySettings,
    isLoading: privacyLoading,
    isFetching: privacyFetching,
    refetch: refetchPrivacy,
  } = usePrivacySettings(userId, {
    enabled: !!userId,
  });
  const updatePrivacyMutation = useUpdatePrivacySettings();

  // Cast privacy settings to a record so we can access dynamic keys
  const settings = privacySettings as Record<string, unknown> | undefined;

  // Derive privacy values from settings
  const profileVisibility = (settings?.profileVisibility as boolean | undefined) ?? true;
  const locationSharing = (settings?.locationSharing as boolean | undefined) ?? false;

  // Blocked and restricted users state
  const [blockedCount, setBlockedCount] = useState(0);
  const [restrictedCount, setRestrictedCount] = useState(0);
  const [fetchedPrivacyUserId, setFetchedPrivacyUserId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingPrivacyKey, setPendingPrivacyKey] = useState<string | null>(null);

  const activePrivacyUserIdRef = useRef<string | undefined>(userId);

  useEffect(() => {
    activePrivacyUserIdRef.current = userId;
  }, [userId]);

  const fetchPrivacyCounts = useCallback(async () => {
    if (!oxyServices || !userId) return;

    const requestedUserId = userId;
    try {
      const [blockedUsers, restrictedUsers] = await Promise.all([
        oxyServices.getBlockedUsers(),
        oxyServices.getRestrictedUsers(),
      ]);

      if (activePrivacyUserIdRef.current !== requestedUserId) return;

      setBlockedCount(Array.isArray(blockedUsers) ? blockedUsers.length : 0);
      setRestrictedCount(Array.isArray(restrictedUsers) ? restrictedUsers.length : 0);
    } finally {
      if (activePrivacyUserIdRef.current === requestedUserId) {
        setFetchedPrivacyUserId(requestedUserId);
      }
    }
  }, [oxyServices, userId]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refetchPrivacy(),
        fetchPrivacyCounts(),
        fetchUserCounts ? Promise.resolve(fetchUserCounts()) : Promise.resolve(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [refetchPrivacy, fetchPrivacyCounts, fetchUserCounts]);

  // Handle privacy setting updates
  const handlePrivacyUpdate = useCallback(async (key: string, value: boolean) => {
    if (!userId) return;

    setPendingPrivacyKey(key);
    try {
      await updatePrivacyMutation.mutateAsync({
        settings: { [key]: value },
        userId,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('sharing.privacy.updateFailed');
      toast.error(message);
    } finally {
      setPendingPrivacyKey((current) => (current === key ? null : current));
    }
  }, [userId, updatePrivacyMutation, t]);

  // Fetch blocked/restricted counts
  useEffect(() => {
    if (!userId) {
      setBlockedCount(0);
      setRestrictedCount(0);
      setFetchedPrivacyUserId(null);
      return;
    }

    if (fetchedPrivacyUserId !== userId) {
      setBlockedCount(0);
      setRestrictedCount(0);
      void fetchPrivacyCounts();
      fetchUserCounts?.();
    }
  }, [userId, fetchedPrivacyUserId, fetchPrivacyCounts, fetchUserCounts]);

  return {
    followerCount,
    followingCount,
    blockedCount,
    restrictedCount,
    profileVisibility,
    locationSharing,
    pendingPrivacyKey,
    handlePrivacyUpdate,
    refreshing,
    privacyLoading,
    privacyFetching,
    handleRefresh,
  };
}
