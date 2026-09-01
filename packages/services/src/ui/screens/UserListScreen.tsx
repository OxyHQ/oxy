import type React from 'react';
import { useEffect, useState, useCallback } from 'react';
import {
  View,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { useTheme } from '@oxyhq/bloom/theme';
import { H6, Text } from '@oxyhq/bloom/typography';
import { Button } from '@oxyhq/bloom/button';
import { Avatar } from '@oxyhq/bloom/avatar';
import FollowButton from '../components/FollowButton';
import Ionicons from '../icons/Ionicons';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/OxyContext';
import { logger, getNormalizedUserHandle, getAccountFallbackHandle } from '@oxyhq/core';
import type { User, FollowGraphSort } from '@oxyhq/core';

type ListMode = 'followers' | 'following';

interface UserListScreenProps extends BaseScreenProps {
  userId: string;
  mode: ListMode;
  initialCount?: number;
  /**
   * Ordering of the list — `recent` (newest follow first) or `oldest`.
   * Omitted ⇒ the server default (`recent`). Changing it re-fetches from
   * offset 0, since a page boundary is meaningless across two orderings.
   */
  sort?: FollowGraphSort;
}

const PAGE_SIZE = 20;
const AVATAR_SIZE = 48;
const EMPTY_ICON_SIZE = 64;
const ERROR_ICON_SIZE = 48;

/**
 * Resolve a user's id from the canonical `id` field, falling back to the
 * Mongo `_id` exposed via `User`'s index signature — narrowed with a `typeof`
 * guard so we never reach for a cast.
 */
const resolveUserId = (user: User): string =>
  user.id || (typeof user._id === 'string' ? user._id : '');

const UserListScreen: React.FC<UserListScreenProps> = ({
  userId,
  mode,
  initialCount,
  sort,
  navigate,
}) => {
  const { oxyServices, user: currentUser } = useOxy();
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(initialCount ?? 0);
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
        let total: number;
        let hasMore: boolean;

        if (mode === 'followers') {
          const result = await oxyServices.getUserFollowers(userId, { limit: PAGE_SIZE, offset, sort });
          newUsers = result.followers;
          total = result.total;
          hasMore = result.hasMore;
        } else {
          const result = await oxyServices.getUserFollowing(userId, { limit: PAGE_SIZE, offset, sort });
          newUsers = result.following;
          total = result.total;
          hasMore = result.hasMore;
        }

        if (offset === 0 || isRefresh) {
          setUsers(newUsers);
        } else {
          setUsers((prev) => [...prev, ...newUsers]);
        }

        setTotal(total);
        setHasMore(hasMore);
      } catch (err) {
        logger.error(`Failed to fetch ${mode}`, err instanceof Error ? err : new Error(String(err)), {
          component: 'UserListScreen',
        });
        setError(`Failed to load ${mode}. Please try again.`);
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
        setIsRefreshing(false);
      }
    },
    // `sort` belongs here: without it the callback would close over the first
    // ordering forever, and the mount effect below (keyed on `fetchUsers`)
    // would never re-run — flipping the control would change nothing.
    [userId, mode, sort, oxyServices]
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
    [navigate]
  );

  const renderUser = useCallback(
    ({ item }: { item: User }) => {
      const itemUserId = resolveUserId(item);
      const isCurrentUser = itemUserId === currentUserId;
      const description = typeof item.description === 'string' ? item.description : '';
      const displayName = item.name?.displayName ?? getNormalizedUserHandle(item) ?? '';
      const handle = getAccountFallbackHandle(item);

      return (
        <TouchableOpacity
          style={styles.userItem}
          className="px-screen-margin py-space-12 gap-space-12"
          onPress={() => handleUserPress(item)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={displayName}
        >
          <Avatar
            source={
              item.avatar
                ? oxyServices.getFileDownloadUrl(item.avatar, 'thumb')
                : undefined
            }
            name={displayName}
            size={AVATAR_SIZE}
          />
          <View style={styles.userInfo}>
            <Text className="text-text font-medium text-base" numberOfLines={1}>
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
          {!isCurrentUser && itemUserId ? (
            <FollowButton userId={itemUserId} size="small" />
          ) : null}
        </TouchableOpacity>
      );
    },
    [handleUserPress, currentUserId, oxyServices]
  );

  const renderEmpty = useCallback(() => {
    if (isLoading) return null;
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
            ? t('userList.noFollowersDesc') || 'When people follow this user, they will appear here.'
            : t('userList.noFollowingDesc') || 'When this user follows people, they will appear here.'}
        </Text>
      </View>
    );
  }, [isLoading, mode, bloomTheme, t]);

  const renderFooter = useCallback(() => {
    if (!isLoadingMore) return null;
    return (
      <View style={styles.footerLoader} className="py-space-16">
        <ActivityIndicator size="small" color={bloomTheme.colors.primary} />
      </View>
    );
  }, [isLoadingMore, bloomTheme]);

  const title = mode === 'followers'
    ? (t('userList.followers') || 'Followers')
    : (t('userList.following') || 'Following');

  const headerSubtitle = total > 0 ? String(total) : undefined;
  useSurfaceHeader({ title, subtitle: headerSubtitle });

  if (isLoading && users.length === 0) {
    return (
      <View className="flex-1 bg-bg">
        <View style={styles.center}>
          <ActivityIndicator size="large" color={bloomTheme.colors.primary} />
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View className="flex-1 bg-bg">
        <View style={styles.center} className="px-space-32 gap-space-16">
          <Ionicons name="alert-circle" size={ERROR_ICON_SIZE} color={bloomTheme.colors.error} />
          <Text className="text-text-secondary text-base text-center">{error}</Text>
          <Button variant="primary" onPress={() => fetchUsers(0)}>
            {t('common.retry') || 'Retry'}
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-bg">
      <FlatList
        data={users}
        renderItem={renderUser}
        keyExtractor={(item, index) => resolveUserId(item) || `user-${index}`}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => (
          <View style={styles.separator} className="border-b border-border" />
        )}
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={renderFooter}
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
  userItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  userInfo: {
    flex: 1,
  },
  // Inset the hairline separator to align with the start of the user's text
  // content (avatar width + screen margin + gap).
  separator: {
    marginLeft: 76,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
  },
  footerLoader: {
    alignItems: 'center',
  },
});

export default UserListScreen;
