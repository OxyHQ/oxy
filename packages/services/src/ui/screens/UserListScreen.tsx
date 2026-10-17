import { Search } from '@oxy.so/bloom/search';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import type React from 'react';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { useTheme } from '@oxy.so/bloom/theme';
import { H6, Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { ContactRow } from '@oxy.so/bloom/chat-people';
import FollowButton from '../components/FollowButton';
import Ionicons from '../icons/Ionicons';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/oxyRuntimeContext';
import { logger, getNormalizedUserHandle, getAccountFallbackHandle } from '@oxy.so/core';
import type { User, FollowGraphSort } from '@oxy.so/core';

type ListMode = 'followers' | 'following';

interface UserListScreenProps extends BaseScreenProps {
  userId: string;
  mode: ListMode;
  initialCount?: number;
  /** @deprecated Ordering is server-owned and never chronological. */
  sort?: FollowGraphSort;
}

const PAGE_SIZE = 20;
const EMPTY_ICON_SIZE = 64;
const ERROR_ICON_SIZE = 48;

/**
 * Resolve a user's id from the canonical `id` field, falling back to the
 * raw `_id` exposed via `User`'s index signature — narrowed with a `typeof`
 * guard so we never reach for a cast.
 */
const resolveUserId = (user: User): string =>
  user.id || (typeof user._id === 'string' ? user._id : '');

const UserListScreen: React.FC<UserListScreenProps> = ({ userId, mode, sort, navigate }) => {
  const { oxyServices, user: currentUser } = useOxy();
  const [users, setUsers] = useState<User[]>([]);
  const fetching = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const bloomTheme = useTheme();
  const { t } = useI18n();

  const currentUserId = currentUser ? resolveUserId(currentUser) : '';

  const fetchUsers = useCallback(
    async (offset = 0, isRefresh = false) => {
      if (!userId) {
        setError('No user ID provided');
        setIsLoading(false);
        return;
      }

      if (fetching.current) return;
      fetching.current = true;
      try {
        if (isRefresh) {
          setIsRefreshing(true);
        } else if (offset === 0) {
          setIsLoading(true);
        } else {
          setIsLoadingMore(true);
        }
        setError(null);

        let newUsers: User[];
        let hasMore: boolean;

        if (mode === 'followers') {
          const result = await oxyServices.follows.followers(userId, {
            limit: PAGE_SIZE,
            offset,
            sort,
          });
          newUsers = result.followers;
          hasMore = result.hasMore;
        } else {
          const result = await oxyServices.follows.following(userId, {
            limit: PAGE_SIZE,
            offset,
            sort,
          });
          newUsers = result.following;
          hasMore = result.hasMore;
        }

        if (offset === 0 || isRefresh) {
          setUsers(newUsers);
        } else {
          setUsers((prev) => [...prev, ...newUsers]);
        }

        setHasMore(hasMore && newUsers.length > 0);
      } catch (err) {
        logger.error(
          `Failed to fetch ${mode}`,
          err instanceof Error ? err : new Error(String(err)),
          {
            component: 'UserListScreen',
          },
        );
        setError(`Failed to load ${mode}. Please try again.`);
      } finally {
        fetching.current = false;
        setIsLoading(false);
        setIsLoadingMore(false);
        setIsRefreshing(false);
      }
    },
    [userId, mode, sort, oxyServices],
  );

  useEffect(() => {
    fetchUsers(0);
  }, [fetchUsers]);

  const handleLoadMore = useCallback(() => {
    if (!isLoadingMore && hasMore && !isLoading) {
      fetchUsers(users.length);
    }
  }, [isLoadingMore, hasMore, isLoading, users.length, fetchUsers]);

  const handleRefresh = useCallback(() => {
    fetchUsers(0, true);
  }, [fetchUsers]);

  const handleUserPress = useCallback(
    (user: User) => {
      const targetUserId = resolveUserId(user);
      if (targetUserId && navigate) {
        navigate('Profile', { userId: targetUserId });
      }
    },
    [navigate],
  );

  const renderUser = useCallback(
    ({ item }: { item: User }) => {
      const itemUserId = resolveUserId(item);
      const isCurrentUser = itemUserId === currentUserId;
      const description =
        item.bio || (typeof item.description === 'string' ? item.description : '');
      const displayName = item.name?.displayName ?? getNormalizedUserHandle(item) ?? '';
      const handle = getAccountFallbackHandle(item);

      return (
        <View className="px-screen-margin flex-row items-center gap-space-12">
          <ContactRow
            id={itemUserId || displayName}
            name={displayName}
            subtitle={handle ? (item.username ? `@${handle}` : handle) : undefined}
            avatar={item.avatar ? oxyServices.assets.publicUrl(item.avatar, 'thumb') : undefined}
            horizontalInset={0}
            style={{ flex: 1 }}
            onPress={() => handleUserPress(item)}
            identitySlot={
              <View style={styles.userInfo}>
                <Text variant="body-medium" numberOfLines={1}>
                  {displayName}
                </Text>
                {handle ? (
                  <Text className="text-text-secondary text-sm mt-space-2" numberOfLines={1}>
                    {item.username ? `@${handle}` : handle}
                  </Text>
                ) : null}
                {description ? (
                  <Text className="text-text-secondary text-sm mt-space-4" numberOfLines={2}>
                    {description}
                  </Text>
                ) : null}
              </View>
            }
          />
          {!isCurrentUser && itemUserId ? <FollowButton userId={itemUserId} size="sm" /> : null}
        </View>
      );
    },
    [handleUserPress, currentUserId, oxyServices],
  );

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleUsers = useMemo(
    () =>
      normalizedSearch
        ? users.filter((user) =>
            [user.name?.displayName, getNormalizedUserHandle(user)].some((value) =>
              value?.toLocaleLowerCase().includes(normalizedSearch),
            ),
          )
        : users,
    [users, normalizedSearch],
  );

  // Search walks the remaining pages too: a match after the first page must
  // not be reported as absent. One page at a time, stopping on error/clear.
  useEffect(() => {
    if (normalizedSearch && hasMore && !isLoading && !isLoadingMore && !isRefreshing && !error) {
      void fetchUsers(users.length);
    }
  }, [
    normalizedSearch,
    hasMore,
    isLoading,
    isLoadingMore,
    isRefreshing,
    error,
    users.length,
    fetchUsers,
  ]);

  const renderEmpty = useCallback(() => {
    if (isLoading || (normalizedSearch && (hasMore || isLoadingMore) && !error)) return null;
    if (normalizedSearch)
      return (
        <View className="px-space-24 py-space-24">
          <Text>{t('userList.noSearchResults')}</Text>
        </View>
      );
    return (
      <View style={styles.emptyContainer} className="px-space-32 gap-space-8">
        <Ionicons
          name={mode === 'followers' ? 'people-outline' : 'heart-outline'}
          size={EMPTY_ICON_SIZE}
          color={bloomTheme.colors.textSecondary}
        />
        <H6 className="text-text text-center mt-space-8">
          {mode === 'followers'
            ? t('userList.noFollowers') || 'No followers yet'
            : t('userList.noFollowing') || 'Not following anyone'}
        </H6>
        <Text className="text-text-secondary text-sm text-center">
          {mode === 'followers'
            ? t('userList.noFollowersDesc') ||
              'When people follow this user, they will appear here.'
            : t('userList.noFollowingDesc') ||
              'When this user follows people, they will appear here.'}
        </Text>
      </View>
    );
  }, [isLoading, mode, bloomTheme, t, normalizedSearch, hasMore, isLoadingMore, error]);

  const title =
    mode === 'followers'
      ? t('userList.followers') || 'Followers'
      : t('userList.following') || 'Following';

  useSurfaceHeader({
    title,
    subtitle: t(
      mode === 'followers' ? 'userList.followersDescription' : 'userList.followingDescription',
    ),
    actions: [
      {
        icon: RiSearchLine,
        accessibilityLabel: t('userList.search'),
        onPress: () => {
          setSearchOpen((open) => !open);
          setSearch('');
        },
      },
    ],
  });

  if (error) {
    return (
      <View className="flex-1 bg-bg">
        <View style={styles.center} className="px-space-32 gap-space-16">
          <Ionicons name="alert-circle" size={ERROR_ICON_SIZE} color={bloomTheme.colors.error} />
          <Text className="text-text-secondary text-base text-center">{error}</Text>
          <Button appearance="solid" tone="accent" onPress={() => fetchUsers(0)}>
            {t('common.retry') || 'Retry'}
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      {searchOpen ? (
        <View className="px-screen-margin pb-space-12" style={{ flexShrink: 0 }}>
          <Search
            label={t('userList.search')}
            placeholder={t('userList.searchPlaceholder')}
            value={search}
            onValueChange={setSearch}
            autoFocus
          />
        </View>
      ) : null}
      <FlatList
        style={{ flex: 1 }}
        data={visibleUsers}
        renderItem={renderUser}
        keyExtractor={(item, index) => resolveUserId(item) || `user-${index}`}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={{ height: 2 }} />}
        ListEmptyComponent={renderEmpty}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.3}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={bloomTheme.colors.primary}
            colors={[bloomTheme.colors.primary]}
          />
        }
      />
    </View>
  );
};

// Layout-only styles: flex centering, measured separator inset, and the row
// flex layout. Colors, spacing, radius, and typography roles live on Bloom
// components + NativeWind token classes.
const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    flexGrow: 1,
  },
  userInfo: {
    flex: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
  },
});

export default UserListScreen;
