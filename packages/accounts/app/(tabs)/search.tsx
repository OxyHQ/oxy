import React, { useMemo, useCallback } from 'react';
import { View, StyleSheet, Platform, useWindowDimensions, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@oxyhq/bloom/theme';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard, EmptyStateCard } from '@/components/ui';
import { menuItems } from '@/components/ui/sidebar-content';
import { darkenColor } from '@/utils/color-utils';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { useOxy, FollowButton as ImportedFollowButton } from '@oxyhq/services';
import { Avatar } from '@oxyhq/bloom/avatar';
import type { User, BlockedUser, RestrictedUser } from '@oxyhq/core';
import { getAccountFallbackHandle, getNormalizedUserHandle } from '@oxyhq/core';
import { useTranslation } from '@/lib/i18n';
import { useDebounce } from '@/hooks/useDebounce';

/** Minimum query length before we hit the profile-search endpoint. */
const MIN_SEARCH_LENGTH = 2;
/** Debounce window applied to the search box before refetching. */
const SEARCH_DEBOUNCE_MS = 500;

// Explicit type annotation to avoid implicit any when services source has transient TS errors
const FollowButton: React.FC<{
  userId: string;
  initiallyFollowing?: boolean;
  size?: 'small' | 'medium' | 'large';
  theme?: 'light' | 'dark';
}> = ImportedFollowButton;

/** ObjectId-like value: a raw MongoDB `_id` exposes `toString()`. */
interface ObjectIdLike {
  toString(): string;
}

/**
 * A user record we can resolve a stable id from. Covers both the standard
 * `User` shape (`id: string`) and raw documents where the id lives on `_id`
 * (either a string or an ObjectId instance).
 */
type IdentifiableUser = Partial<User> & {
  _id?: string | ObjectIdLike;
};

export default function SearchScreen() {
  const { mode } = useTheme();
  const colors = useColors();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const params = useLocalSearchParams<{ q?: string }>();
  const searchQuery = params.q || '';
  const isDesktop = useMemo(() => Platform.OS === 'web' && width >= 768, [width]);
  const { t } = useTranslation();

  // OxyServices integration
  const { user, oxyServices, isAuthenticated, showBottomSheet } = useOxy();

  // Helper to safely extract and validate user ID. Accepts either a standard
  // `User` (with `id`) or a raw MongoDB document where the identifier is `_id`
  // (a string or an ObjectId-like value exposing `toString()`).
  const extractUserId = useCallback((candidate: IdentifiableUser | null | undefined): string | null => {
    if (!candidate) return null;

    // Try id field first (standard User interface)
    if (typeof candidate.id === 'string' && candidate.id.trim().length > 0) {
      return candidate.id.trim();
    }

    // Try _id field (MongoDB format)
    const rawId = candidate._id;
    if (typeof rawId === 'string') {
      const trimmed = rawId.trim();
      if (trimmed.length > 0) return trimmed;
    } else if (rawId && typeof rawId.toString === 'function') {
      // If _id is an ObjectId instance, convert to string
      const idString = rawId.toString().trim();
      if (idString.length > 0) return idString;
    }

    return null;
  }, []);

  // Blocked / restricted lists power the result filter below. They are cached
  // independently of the search term so typing does not re-fetch them.
  const blockedQuery = useQuery<BlockedUser[]>({
    queryKey: ['search', 'blocked', user?.id ?? null],
    queryFn: () => oxyServices.getBlockedUsers(),
    enabled: isAuthenticated && !!user?.id,
    staleTime: 5 * 60 * 1000,
  });
  const restrictedQuery = useQuery<RestrictedUser[]>({
    queryKey: ['search', 'restricted', user?.id ?? null],
    queryFn: () => oxyServices.getRestrictedUsers(),
    enabled: isAuthenticated && !!user?.id,
    staleTime: 5 * 60 * 1000,
  });
  const blockedUsers = useMemo(() => blockedQuery.data ?? [], [blockedQuery.data]);
  const restrictedUsers = useMemo(() => restrictedQuery.data ?? [], [restrictedQuery.data]);

  // Debounce the raw query into the React Query key: the profile-search request
  // fires once typing settles, replacing the manual `setTimeout` ref + effect.
  const debouncedQuery = useDebounce(searchQuery.trim(), SEARCH_DEBOUNCE_MS);
  const canSearch = isAuthenticated && debouncedQuery.length >= MIN_SEARCH_LENGTH;

  const searchQueryResult = useQuery<User[]>({
    queryKey: ['search', 'profiles', debouncedQuery],
    queryFn: async () => {
      const response = await oxyServices.searchProfiles(debouncedQuery, { limit: 10 });
      return response.data ?? [];
    },
    enabled: canSearch,
    staleTime: 60 * 1000,
  });

  // Filtering (current user, blocked, restricted) is derived from the raw
  // results so it re-applies reactively when the blocked/restricted lists load,
  // without re-issuing the search request.
  const userSearchResults = useMemo<User[]>(() => {
    if (!canSearch) return [];
    const rawResults = searchQueryResult.data ?? [];
    const currentUserId = extractUserId(user);

    return rawResults.filter((candidate: User) => {
      const userId = extractUserId(candidate);
      if (!userId) return false; // Skip invalid users
      if (!currentUserId) return false;
      if (userId === currentUserId) return false; // Filter out current user

      const isBlocked = blockedUsers.some((blocked) => {
        const blockedId = typeof blocked.blockedId === 'string'
          ? blocked.blockedId
          : (blocked.blockedId._id || '');
        return blockedId === userId;
      });
      if (isBlocked) return false;

      const isRestricted = restrictedUsers.some((restricted) => {
        const restrictedId = typeof restricted.restrictedId === 'string'
          ? restricted.restrictedId
          : (restricted.restrictedId._id || '');
        return restrictedId === userId;
      });
      if (isRestricted) return false;

      return true;
    });
  }, [canSearch, searchQueryResult.data, user, blockedUsers, restrictedUsers, extractUserId]);

  // "Searching…" is shown while the debounced query is in flight (covers the
  // initial fetch and any background refetch after typing settles).
  const isSearchingUsers = canSearch && (searchQueryResult.isLoading || searchQueryResult.isFetching);

  // Pull-to-refresh re-fetches the blocked/restricted lists and the active
  // search in parallel; `refreshing` mirrors their combined fetch state.
  const handleRefresh = useCallback(async () => {
    if (!isAuthenticated) return;
    const refreshPromises: Promise<unknown>[] = [];
    if (user?.id) {
      refreshPromises.push(blockedQuery.refetch(), restrictedQuery.refetch());
    }
    if (canSearch) {
      refreshPromises.push(searchQueryResult.refetch());
    }
    await Promise.all(refreshPromises);
  }, [isAuthenticated, user?.id, canSearch, blockedQuery, restrictedQuery, searchQueryResult]);

  const refreshing =
    blockedQuery.isRefetching ||
    restrictedQuery.isRefetching ||
    searchQueryResult.isRefetching;

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) {
      return [];
    }
    const query = searchQuery.toLowerCase();
    return menuItems.filter(item =>
      t(item.labelKey).toLowerCase().includes(query)
    );
  }, [searchQuery, t]);

  const groupedItems = useMemo(() => {
    return filteredItems.map((item) => {
      const iconColor = colors[item.iconColor as keyof typeof colors] as string;
      return {
        id: item.path,
        icon: item.icon,
        iconColor: iconColor,
        title: t(item.labelKey),
        onPress: () => router.push(item.path),
        showChevron: true,
      };
    });
  }, [filteredItems, colors, router, t]);

  // Transform user search results to GroupedSection items with FollowButton
  const userSearchResultItems = useMemo(() => {
    return userSearchResults
      .map((user) => {
        const userId = extractUserId(user);
        if (!userId) return null; // Skip invalid users

        // Canonical display-name contract for a profile DTO: the API-owned
        // name.displayName, then the normalized handle. No multi-field chain.
        const displayName = user.name?.displayName ?? getNormalizedUserHandle(user) ?? '';
        const userUsername = user.username || undefined;
        const fallbackHandle = getAccountFallbackHandle(user);
        const avatarUrl = user.avatar && oxyServices
          ? oxyServices.getFileDownloadUrl(user.avatar, 'thumb')
          : undefined;

        return {
          id: userId,
          title: displayName,
          subtitle: user.bio
            || (fallbackHandle ? (user.username ? `@${fallbackHandle}` : fallbackHandle) : displayName),
          customIcon: (
            <Avatar
              name={displayName}
              source={avatarUrl}
              size={40}
            />
          ),
          customContent: (
            <FollowButton
              userId={userId}
              initiallyFollowing={false}
              size="small"
              theme={mode}
            />
          ),
          onPress: () => {
            if (showBottomSheet) {
              showBottomSheet({
                screen: 'Profile',
                props: {
                  userId: userId,
                  username: userUsername,
                },
              });
            }
          },
          showChevron: true,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [userSearchResults, oxyServices, mode, extractUserId, showBottomSheet]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenContentWrapper refreshing={refreshing} onRefresh={handleRefresh}>
        <View style={[styles.content, isDesktop && styles.desktopContent]}>
          {!searchQuery.trim() ? (
            <View style={styles.startSearchContainer}>
              <View style={styles.startSearchContent}>
                <MaterialCommunityIcons
                  name="magnify"
                  size={isDesktop ? 96 : 64}
                  color={colors.text}
                  style={styles.startSearchIcon}
                />
                <View style={styles.titleDescriptionWrapper}>
                  <ThemedText style={[styles.startSearchTitle, { color: colors.text }]}>{t('search.startTitle')}</ThemedText>
                  <ThemedText style={[styles.startSearchSubtitle, { color: colors.text }]}>
                    {t('search.startSubtitle')}
                  </ThemedText>
                </View>
                <View style={styles.suggestionsContainer}>
                  <ThemedText style={[styles.suggestionsTitle, { color: colors.text }]}>{t('search.suggestionsTitle')}</ThemedText>
                  <View style={styles.suggestionsList}>
                    {menuItems.slice(0, 6).map((item) => {
                      const iconColor = colors[item.iconColor as keyof typeof colors] as string;
                      return (
                        <TouchableOpacity
                          key={item.path}
                          style={[styles.suggestionItem, { backgroundColor: colors.card }]}
                          onPress={() => router.push(item.path)}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel={t('a11y.suggestion', { title: t(item.labelKey) })}
                        >
                          <View style={[styles.suggestionIcon, { backgroundColor: iconColor }]}>
                            <MaterialCommunityIcons name={item.icon} size={20} color={darkenColor(iconColor)} />
                          </View>
                          <ThemedText style={[styles.suggestionText, { color: colors.text }]}>{t(item.labelKey)}</ThemedText>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              </View>
            </View>
          ) : (
            <>
              <View style={styles.header}>
                <ThemedText style={styles.subtitle}>
                  {t('search.resultsCount', { count: filteredItems.length + userSearchResultItems.length, query: searchQuery })}
                </ThemedText>
              </View>
              {filteredItems.length === 0 && userSearchResultItems.length === 0 && !isSearchingUsers ? (
                <EmptyStateCard
                  icon="magnify"
                  title={t('search.noResults')}
                  subtitle={t('search.noResultsSubtitle')}
                />
              ) : (
                <>
                  {filteredItems.length > 0 && (
                    <Section isFirst>
                      <ThemedText style={[styles.sectionTitle, { color: colors.text }]}>{t('search.screens')}</ThemedText>
                      <AccountCard>
                        <GroupedSection items={groupedItems} />
                      </AccountCard>
                    </Section>
                  )}
                  {isSearchingUsers && userSearchResultItems.length === 0 && (
                    <Section isFirst={filteredItems.length === 0}>
                      <View style={styles.loadingContainer}>
                        <ActivityIndicator size="small" color={colors.tint} />
                        <ThemedText style={[styles.loadingText, { color: colors.text }]}>{t('search.searchingUsers')}</ThemedText>
                      </View>
                    </Section>
                  )}
                  {userSearchResultItems.length > 0 && (
                    <Section isFirst={filteredItems.length === 0}>
                      <ThemedText style={[styles.sectionTitle, { color: colors.text }]}>{t('search.people')}</ThemedText>
                      <AccountCard>
                        <GroupedSection items={userSearchResultItems} />
                      </AccountCard>
                    </Section>
                  )}
                </>
              )}
            </>
          )}
        </View>
      </ScreenContentWrapper>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 24,
    paddingTop: 0,
  },
  desktopContent: {
    padding: 32,
    maxWidth: 800,
    alignSelf: 'center',
    width: '100%',
  },
  header: {
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '600',
    marginBottom: 8,
    lineHeight: 36,
  },
  subtitle: {
    fontSize: 16,
    opacity: 0.6,
    lineHeight: 22,
  },
  startSearchContainer: {
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
    paddingTop: Platform.OS === 'web' ? 40 : 20,
    paddingBottom: 40,
  },
  startSearchContent: {
    alignItems: 'flex-start',
    width: '100%',
  },
  startSearchIcon: {
    marginBottom: 24,
  },
  titleDescriptionWrapper: {
    maxWidth: 600,
    width: '100%',
    marginBottom: 32,
  },
  startSearchTitle: {
    fontSize: Platform.OS === 'web' ? 56 : 36,
    fontWeight: Platform.OS === 'web' ? 'bold' : undefined,
    marginBottom: 16,
    textAlign: 'left',
    lineHeight: Platform.OS === 'web' ? 64 : 44,
  },
  startSearchSubtitle: {
    fontSize: Platform.OS === 'web' ? 18 : 16,
    opacity: 0.7,
    textAlign: 'left',
    lineHeight: Platform.OS === 'web' ? 26 : 24,
  },
  suggestionsContainer: {
    width: '100%',
    alignItems: 'flex-start',
  },
  suggestionsTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    opacity: 0.8,
  },
  suggestionsList: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingLeft: 8,
    paddingRight: 16,
    borderRadius: 999,
    gap: 8,
  },
  suggestionIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestionText: {
    fontSize: 15,
    opacity: 0.8,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    marginTop: 8,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
    gap: 12,
  },
  loadingText: {
    fontSize: 16,
    opacity: 0.7,
  },
});

