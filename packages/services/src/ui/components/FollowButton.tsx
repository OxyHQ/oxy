import type React from 'react';
import { useEffect, useCallback, useMemo, useState, memo } from 'react';
import type {
  ViewStyle,
  TextStyle,
  StyleProp,
} from 'react-native';
import { ActivityIndicator } from 'react-native';
import { useOxy } from '../context/OxyContext';
import { toast } from '@oxyhq/bloom/toast';
import { Button } from '@oxyhq/bloom/button';
import { useFollow, useFollowForButton } from '../hooks/useFollow';
import { useFollowStore } from '../stores/followStore';
import { useTheme } from '@oxyhq/bloom/theme';
import type { OxyServices, BulkFollowResult, BulkUnfollowResult } from '@oxyhq/core';
import { useShallow } from 'zustand/react/shallow';

const DEFAULT_FOLLOW_ALL_LABEL = 'Follow all';
const DEFAULT_FOLLOWED_ALL_LABEL = 'Following';

/** Props shared by both single- and multi-user follow modes. */
interface FollowButtonBaseProps {
  size?: 'small' | 'medium' | 'large';
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  disabled?: boolean;
  showLoadingState?: boolean;
  preventParentActions?: boolean;
  theme?: 'light' | 'dark';
  onFollowChange?: (isFollowing: boolean) => void;
}

/** Single-user mode — follows/unfollows one user (existing behavior). */
export interface SingleFollowButtonProps extends FollowButtonBaseProps {
  userId: string;
  initiallyFollowing?: boolean;
  userIds?: never;
}

/** Multi-user mode — follows MANY users in one "Follow all" action (follow-only). */
export interface MultiFollowButtonProps extends FollowButtonBaseProps {
  userIds: string[];
  initiallyAllFollowing?: boolean;
  followAllLabel?: string;
  followedAllLabel?: string;
  onBulkFollow?: (result: BulkFollowResult) => void;
  onBulkUnfollow?: (result: BulkUnfollowResult) => void;
  userId?: never;
}

/**
 * FollowButton accepts EITHER single-user mode (`userId`) or multi-user mode
 * (`userIds`), never both. Existing `{ userId, ... }` callers remain valid.
 */
export type FollowButtonProps = SingleFollowButtonProps | MultiFollowButtonProps;

const isMultiMode = (props: FollowButtonProps): props is MultiFollowButtonProps =>
  'userIds' in props && Array.isArray(props.userIds);

const FollowButtonInner = memo(function FollowButtonInner({
  userId,
  oxyServices,
  initiallyFollowing,
  size = 'medium',
  onFollowChange,
  style,
  textStyle,
  disabled = false,
  showLoadingState = true,
  preventParentActions = true,
}: SingleFollowButtonProps & { oxyServices: OxyServices }) {
  const { colors } = useTheme();

  const {
    isFollowing,
    isKnown,
    isLoading,
    toggleFollow,
    resolveStatus,
  } = useFollowForButton(userId, oxyServices, initiallyFollowing);

  const handlePress = useCallback(async (event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
    if (preventParentActions && event?.preventDefault) {
      event.preventDefault();
      event.stopPropagation?.();
    }
    // Ignore presses while a mutation is in flight or the status is still unknown.
    if (disabled || isLoading || !isKnown) return;

    try {
      const accepted = await toggleFollow();
      if (accepted) onFollowChange?.(!isFollowing);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      toast.error(error.message || 'Failed to update follow status');
    }
  }, [disabled, isLoading, isKnown, toggleFollow, onFollowChange, isFollowing, preventParentActions]);

  // Enqueue a batched status fetch ONLY when the status is genuinely unknown
  // (not seeded from `initiallyFollowing`, not already resolved). All buttons
  // that enqueue in the same commit coalesce into a single bulk request; known/
  // seeded ids never fetch. Once resolved, `isKnown` flips true and this no-ops.
  useEffect(() => {
    if (!isKnown) resolveStatus();
  }, [isKnown, resolveStatus]);

  // While the status is genuinely unknown (being resolved), present a NEUTRAL,
  // non-interactive state rather than a definitive "Follow".
  const isBusy = isLoading || !isKnown;
  const showFollowing = isKnown && isFollowing;
  const showSpinner = showLoadingState && isBusy;

  return (
    <Button
      variant={showFollowing ? 'secondary' : 'primary'}
      size={size}
      onPress={() => { void handlePress(); }}
      disabled={disabled || isBusy}
      style={style}
      textStyle={textStyle}
      icon={showSpinner ? (
        <ActivityIndicator
          size="small"
          color={showFollowing ? colors.text : colors.primaryForeground}
        />
      ) : undefined}
    >
      {showSpinner ? undefined : (isKnown ? (isFollowing ? 'Following' : 'Follow') : undefined)}
    </Button>
  );
});

const FollowButtonMultiInner = memo(function FollowButtonMultiInner({
  userIds,
  initiallyAllFollowing = false,
  size = 'medium',
  followAllLabel = DEFAULT_FOLLOW_ALL_LABEL,
  followedAllLabel = DEFAULT_FOLLOWED_ALL_LABEL,
  onFollowChange,
  onBulkFollow,
  onBulkUnfollow,
  style,
  textStyle,
  disabled = false,
  showLoadingState = true,
  preventParentActions = true,
}: MultiFollowButtonProps) {
  const { colors } = useTheme();
  const follow = useFollow(userIds);
  const followAllUsers = 'followAllUsers' in follow ? follow.followAllUsers : undefined;
  const unfollowAllUsers = 'unfollowAllUsers' in follow ? follow.unfollowAllUsers : undefined;
  const isAnyLoading = 'isAnyLoading' in follow ? follow.isAnyLoading : false;

  const initialFollowStatuses = useFollowStore(
    useShallow((state) => {
      const statuses: Record<string, boolean | null> = {};
      for (const uid of userIds) {
        statuses[uid] = Object.prototype.hasOwnProperty.call(state.followingUsers, uid)
          ? state.followingUsers[uid]
          : null;
      }
      return statuses;
    })
  );

  const hasKnownNotFollowing = userIds.some((uid) => initialFollowStatuses[uid] === false);

  // `allFollowing` is store-derived (LIVE aggregate of each target's follow
  // status) — it reacts in real time as individual members are followed or
  // unfollowed elsewhere. `initiallyAllFollowing` preserves the public initial
  // state contract until the store learns that any member is not followed. Only
  // `isSubmitting` is transient local state for the in-flight bulk call.
  const storeAllFollowing = 'allFollowing' in follow ? follow.allFollowing : false;
  const allFollowing = storeAllFollowing || (initiallyAllFollowing && !hasKnownNotFollowing);
  const fetchAllStatuses = 'fetchAllStatuses' in follow ? follow.fetchAllStatuses : undefined;
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isLoading = isSubmitting || isAnyLoading;

  // Populate the store with each member's follow status on mount and whenever
  // the target set changes. `fetchAllStatuses` is recreated when `userIds`
  // changes inside `useFollow`, so it is the sole effect dependency — no need
  // for a joined-string key. `allFollowing`/loading are intentionally NOT in
  // the deps.
  useEffect(() => {
    fetchAllStatuses?.();
  }, [fetchAllStatuses]);

  const handlePress = useCallback(async (event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
    if (preventParentActions && event?.preventDefault) {
      event.preventDefault();
      event.stopPropagation?.();
    }
    if (disabled || isLoading) return;

    if (allFollowing) {
      if (!unfollowAllUsers) return;
      setIsSubmitting(true);
      try {
        const result = await unfollowAllUsers();
        // `unfollowManyUsers` flips each user to not-following in the store, so
        // `allFollowing` becomes false reactively — no local flag.
        onFollowChange?.(false);
        onBulkUnfollow?.(result);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        toast.error(error.message || 'Failed to update follow status');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!followAllUsers) return;
    setIsSubmitting(true);
    try {
      const result = await followAllUsers();
      const allAlreadyFollowing = result.followedCount === 0
        && result.results.length > 0
        && result.results.every((entry) => entry.alreadyFollowing);
      const anyFollowed = result.followedCount > 0
        || result.results.some((entry) => entry.success || entry.alreadyFollowing);

      // `followManyUsers` marks each user followed in the store, so `allFollowing`
      // flips to true reactively — no local flag to set here.
      if (allAlreadyFollowing || anyFollowed) {
        onFollowChange?.(true);
      }
      onBulkFollow?.(result);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      toast.error(error.message || 'Failed to update follow status');
    } finally {
      setIsSubmitting(false);
    }
  }, [disabled, isLoading, allFollowing, followAllUsers, unfollowAllUsers, onFollowChange, onBulkFollow, onBulkUnfollow, preventParentActions]);

  const showSpinner = showLoadingState && isLoading;

  return (
    <Button
      variant={allFollowing ? 'secondary' : 'primary'}
      size={size}
      onPress={() => { void handlePress(); }}
      disabled={disabled || isLoading}
      style={style}
      textStyle={textStyle}
      icon={showSpinner ? (
        <ActivityIndicator
          size="small"
          color={allFollowing ? colors.text : colors.primaryForeground}
        />
      ) : undefined}
    >
      {showSpinner ? undefined : (allFollowing ? followedAllLabel : followAllLabel)}
    </Button>
  );
});

const FollowButton: React.FC<FollowButtonProps> = (props) => {
  const { oxyServices, canUsePrivateApi, user: currentUser } = useOxy();

  const currentUserId = currentUser?.id ? String(currentUser.id).trim() : '';

  const rawUserIds = isMultiMode(props) ? props.userIds : null;

  // Multi-user mode: dedupe, trim, drop the current user, and bail if empty.
  const multiUserIds = useMemo(() => {
    if (!rawUserIds) return [];
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of rawUserIds) {
      const id = raw ? String(raw).trim() : '';
      if (!id || id === currentUserId || seen.has(id)) continue;
      seen.add(id);
      cleaned.push(id);
    }
    return cleaned;
  }, [rawUserIds, currentUserId]);

  if (!canUsePrivateApi) {
    return null;
  }

  if (isMultiMode(props)) {
    if (multiUserIds.length === 0) {
      return null;
    }
    return (
      <FollowButtonMultiInner
        {...props}
        userIds={multiUserIds}
      />
    );
  }

  const targetUserId = props.userId ? String(props.userId).trim() : '';
  if (!targetUserId || (currentUserId && currentUserId === targetUserId)) {
    return null;
  }

  return (
    <FollowButtonInner
      {...props}
      userId={targetUserId}
      oxyServices={oxyServices}
    />
  );
};

export { FollowButton };
export default FollowButton;
