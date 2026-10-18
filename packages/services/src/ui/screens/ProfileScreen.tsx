import type React from 'react';
import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { BaseScreenProps } from '../types/navigation';
import { useTheme } from '@oxy.so/bloom/theme';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { useSurfaceFill } from '@oxy.so/bloom/styles';
import { H2, Text } from '@oxy.so/bloom/typography';
import { Avatar } from '@oxy.so/bloom/avatar';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { CoverHeader } from '@oxy.so/bloom/cover-header';
import FollowButton from '../components/FollowButton';
import { useFollow } from '../hooks/useFollow';
import Ionicons from '../icons/Ionicons';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/oxyRuntimeContext';
import { getNormalizedUserHandle, logger } from '@oxy.so/core';
import { extractErrorMessage } from '../utils/errorHandlers';

interface ProfileScreenProps extends BaseScreenProps {
  userId: string;
  username?: string;
}

const AVATAR_SIZE = 96;
const INFO_ICON_SIZE = 18;

const ProfileScreen: React.FC<ProfileScreenProps> = ({ userId, username, navigate }) => {
  // Use useOxy() hook for OxyContext values. "Me" for own-profile detection
  // and the own-profile fallback is the ACTIVE account (the account switched
  // into), so previewing my profile while switched into an org/project/bot
  // resolves "this is mine" against that account, not the session owner.
  const { oxyServices, user: currentUser } = useOxy();

  // Use the follow hook for real follower data
  const { followerCount, followingCount, isLoadingCounts } = useFollow(userId);

  const bloomTheme = useTheme();
  const surfaceFill = useSurfaceFill();
  const { t, locale } = useI18n();

  // Check if current user is viewing their own profile
  // Normalize IDs by trimming whitespace to handle format mismatches
  const normalizeId = (id: string | undefined | null): string => {
    if (!id) return '';
    return String(id).trim();
  };

  const currentUserId = normalizeId(currentUser?.id);
  const targetUserId = normalizeId(userId);
  const isOwnProfile = !!(currentUserId && targetUserId && currentUserId === targetUserId);

  // Profile + reputation + stats in ONE React Query (no data-fetch effect). The
  // reputation/stats reads swallow their own failures; only `getUserById` can
  // reject the query, and for MY OWN profile a failed fetch falls back to the
  // active-account snapshot instead of erroring. The key includes both ids so a
  // switch/own-profile change refetches.
  const profileQuery = useQuery({
    queryKey: ['profileScreen', targetUserId, currentUserId],
    enabled: !!userId,
    retry: false,
    queryFn: async () => {
      // Follower/following counts come from the `useFollow` hook.
      const [profileRes, reputationRes] = await Promise.all([
        oxyServices.users.get(userId).catch((err: unknown) => {
          if (isOwnProfile) return currentUser;
          logger.error(
            'Profile loading error',
            err instanceof Error ? err : new Error(String(err)),
            { component: 'ProfileScreen' },
          );
          throw err;
        }),
        (isOwnProfile ? oxyServices.reputation.balance() : oxyServices.reputation.balance(userId))
          .then((balance): { total: number | undefined } => ({ total: balance.total }))
          .catch((): { total: number | undefined } => ({ total: undefined })),
      ]);
      if (!profileRes) {
        throw new Error('Profile data is not available');
      }
      return {
        profile: profileRes,
        reputationTotal: typeof reputationRes.total === 'number' ? reputationRes.total : null,
      };
    },
  });

  const profile = profileQuery.data?.profile ?? (isOwnProfile ? currentUser : null);
  const reputationTotal = profileQuery.data?.reputationTotal ?? null;

  // Friendly, status-aware error copy derived from the query error (no effect).
  const error = useMemo<string | null>(() => {
    if (!userId) return 'No user ID provided';
    if (!profileQuery.isError) return null;
    const err = profileQuery.error;
    const errorWithStatus =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status?: number; message?: string })
        : null;
    const errorMessageText = extractErrorMessage(err, '');
    if (
      errorWithStatus?.status === 404 ||
      errorMessageText.includes('not found') ||
      errorMessageText.includes('Resource not found')
    ) {
      return isOwnProfile
        ? 'Unable to load your profile from the server. This may be due to a temporary service issue.'
        : 'This user profile could not be found or may have been removed.';
    }
    if (errorWithStatus?.status === 403) {
      return 'You do not have permission to view this profile.';
    }
    if (errorWithStatus?.status === 500) {
      return 'Server error occurred while loading the profile. Please try again later.';
    }
    return errorMessageText || 'Failed to load profile';
  }, [userId, profileQuery.isError, profileQuery.error, isOwnProfile]);

  // The dialog owns navigation chrome; CoverHeader owns the profile artwork
  // and avatar overlap. A neutral cover is not an on-image navigation surface.
  const displayName = profile
    ? (profile.name?.displayName ?? getNormalizedUserHandle(profile) ?? '')
    : username || '';
  useSurfaceHeader({
    title: displayName || t('profile.title'),
    largeTitle: false,
  });

  if (error) {
    // The shared nav header owns back/close; the error body is just the alert.
    return (
      <View style={styles.errorContent} className="px-space-32 gap-space-12 py-space-40">
        <Ionicons name="alert-circle" size={48} color={bloomTheme.colors.error} />
        <H2 style={styles.errorTitle} className="text-text text-center">
          {t('profile.errorTitle') || 'Profile Error'}
        </H2>
        <Text style={styles.errorText} className="text-text">
          {error}
        </Text>
        <Text style={styles.errorSubtext} className="text-text-secondary">
          {t('profile.errorSubtext') ||
            "This could happen if the user doesn't exist or the profile service is unavailable."}
        </Text>
      </View>
    );
  }

  if (!profile && profileQuery.isPending) {
    return (
      <View
        testID="profile-skeleton"
        accessibilityLabel={t('common.loading')}
        accessibilityState={{ busy: true }}
        style={styles.scrollContainer}
      >
        <CoverHeader>
          <View style={styles.avatarRow} className="px-screen-margin">
            <Skeleton.Circle size={AVATAR_SIZE} />
            <Skeleton.Box width={88} height={32} borderRadius={16} />
          </View>
          <View className="px-screen-margin gap-space-8" style={styles.header}>
            <Skeleton.Box width={180} height={28} />
            <Skeleton.Box width={110} height={18} />
            <Skeleton.Box width="100%" height={18} style={{ marginTop: 10 }} />
            <Skeleton.Box width="75%" height={18} />
          </View>
        </CoverHeader>
        <View className="px-screen-margin gap-space-12" style={styles.details}>
          <Skeleton.Box width="65%" height={18} />
          <Skeleton.Box width="85%" height={18} />
        </View>
      </View>
    );
  }

  // The singular `location` field was removed from the User contract; derive
  // the primary place from the `locations` list instead. `locations` is only
  // reachable through the User index signature (typed `unknown`), so narrow it
  // defensively before rendering the chip.
  const primaryLocation = ((): string | undefined => {
    const locations = profile?.locations;
    const first: unknown = Array.isArray(locations) ? locations[0] : undefined;
    if (first && typeof first === 'object' && 'name' in first && typeof first.name === 'string') {
      return first.name || undefined;
    }
    return undefined;
  })();

  const metadata: Array<{
    key: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
  }> = [];
  if (primaryLocation)
    metadata.push({ key: 'location', icon: 'location-outline', label: primaryLocation });
  if (profile?.createdAt) {
    const joined = new Date(profile.createdAt);
    if (!Number.isNaN(joined.getTime()))
      metadata.push({
        key: 'joined',
        icon: 'calendar-outline',
        label: t('profile.joinedOn', {
          date: joined.toLocaleDateString(locale, { month: 'long', year: 'numeric' }),
        }),
      });
  }
  for (const [key, icon] of [
    ['company', 'business-outline'],
    ['jobTitle', 'briefcase-outline'],
    ['education', 'school-outline'],
  ] as const) {
    const value = profile?.[key];
    if (typeof value === 'string' && value.trim()) metadata.push({ key, icon, label: value });
  }
  if (typeof profile?.birthday === 'string' && profile.birthday) {
    const birthday = new Date(profile.birthday);
    if (!Number.isNaN(birthday.getTime()))
      metadata.push({
        key: 'birthday',
        icon: 'gift-outline',
        label: t('profile.bornOn', {
          date: birthday.toLocaleDateString(locale, { timeZone: 'UTC' }),
        }),
      });
  }
  let websiteUrl: string | undefined;
  if (profile?.website) {
    try {
      const url = new URL(profile.website);
      if (url.protocol === 'https:' || url.protocol === 'http:') websiteUrl = url.href;
    } catch {
      /* Invalid profile URLs are not interactive links. */
    }
  }

  return (
    <View style={styles.scrollContainer}>
      <CoverHeader testID="profile-cover-header">
        {/* Avatar overlapping banner */}
        <View style={styles.avatarRow} className="px-screen-margin">
          <View
            style={[
              styles.avatarWrapper,
              { borderColor: surfaceFill, backgroundColor: surfaceFill },
            ]}
            className="rounded-radius-max"
          >
            <Avatar
              // `getFileDownloadUrl` answers `null` for a reference it cannot
              // resolve, and `Avatar.source` takes `undefined` for "no picture" —
              // the two spellings of absent do not meet, so the coalesce is the
              // whole fix. Without it this file does not typecheck, which blocks
              // `bun run build` and therefore every publish of this package.
              source={
                profile?.avatar
                  ? (oxyServices.assets.publicUrl(profile.avatar, 'thumb') ?? undefined)
                  : undefined
              }
              name={displayName}
              size={AVATAR_SIZE}
            />
          </View>
          {/* Conditional Action Button */}
          <View style={styles.actionButtonWrapper}>
            {isOwnProfile ? (
              <View style={styles.profileActions}>
                <Button
                  appearance="subtle"
                  tone="neutral"
                  size="sm"
                  onPress={() => navigate?.('EditProfile')}
                >
                  {t('editProfile.title') || 'Edit Profile'}
                </Button>
                <ButtonGroup>
                  <ButtonGroupItem
                    iconOnly
                    leadingIcon={RiSettings3Line}
                    accessibilityLabel={t('accountMenu.settings') || 'Settings'}
                    onPress={() => navigate?.('Preferences')}
                  />
                </ButtonGroup>
              </View>
            ) : (
              <FollowButton
                userId={userId}
                onFollowChange={(isFollowing) => {
                  // The follow button will automatically update counts via Zustand
                  if (__DEV__) {
                    logger.debug(`Follow status changed: ${isFollowing}`, {
                      component: 'ProfileScreen',
                    });
                  }
                }}
              />
            )}
          </View>
        </View>
        {/* Profile Info */}
        <View style={styles.header} className="px-screen-margin">
          <H2 style={styles.displayName} className="text-text">
            {displayName}
          </H2>
          {profile?.username && (
            <Text style={styles.subText} className="text-text-secondary">
              @{profile.username}
            </Text>
          )}
          {/* Bio */}
          {profile?.bio ? (
            <Text style={styles.bio} className="text-text">
              {profile.bio}
            </Text>
          ) : null}
        </View>
      </CoverHeader>

      <View className="px-screen-margin" style={styles.details}>
        <View style={styles.metadataRow}>
          {metadata.map(({ key, icon, label }) => (
            <View key={key} style={styles.metadataEntry}>
              <Ionicons name={icon} size={16} color={bloomTheme.colors.textSecondary} />
              <Text style={[styles.metadataText, { color: bloomTheme.colors.textSecondary }]}>
                {label}
              </Text>
            </View>
          ))}
        </View>
        {websiteUrl ? (
          <LinkButton
            size="sm"
            href={websiteUrl}
            style={{ alignSelf: 'flex-start', paddingLeft: 0, paddingRight: 0 }}
            target="_blank"
            rel="noopener noreferrer"
            icon={<Ionicons name="link-outline" size={INFO_ICON_SIZE} />}
          >
            {profile?.website}
          </LinkButton>
        ) : null}
        <View style={styles.statsRow}>
          {!isLoadingCounts && followingCount !== null ? (
            <PressableScale
              style={styles.statItem}
              accessibilityLabel={`${followingCount} ${t('profile.following')}`}
              onPress={() => navigate?.('FollowingList', { userId, initialCount: followingCount })}
            >
              <Text style={[styles.statNumber, { color: bloomTheme.colors.text }]}>
                {followingCount}
              </Text>
              <Text style={[styles.statLabel, { color: bloomTheme.colors.textSecondary }]}>
                {t('profile.following')}
              </Text>
            </PressableScale>
          ) : null}
          {!isLoadingCounts && followerCount !== null ? (
            <PressableScale
              style={styles.statItem}
              accessibilityLabel={`${followerCount} ${t('profile.followers')}`}
              onPress={() => navigate?.('FollowersList', { userId, initialCount: followerCount })}
            >
              <Text style={[styles.statNumber, { color: bloomTheme.colors.text }]}>
                {followerCount}
              </Text>
              <Text style={[styles.statLabel, { color: bloomTheme.colors.textSecondary }]}>
                {t('profile.followers')}
              </Text>
            </PressableScale>
          ) : null}
          {reputationTotal !== null ? (
            <View style={styles.statItem}>
              <Text style={[styles.statNumber, { color: bloomTheme.colors.text }]}>
                {reputationTotal}
              </Text>
              <Text style={[styles.statLabel, { color: bloomTheme.colors.textSecondary }]}>
                {t('profile.reputation')}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
};

// Layout-only styles: flex, dimensions, and the measured banner/avatar overlap
// that no token class can express. Colors, spacing, radius, and typography roles
// live on Bloom components + NativeWind token classes.
const styles = StyleSheet.create({
  scrollContainer: { alignItems: 'stretch', paddingBottom: 40 },
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    zIndex: 2,
  },
  avatarWrapper: { borderWidth: 5, overflow: 'hidden' },
  actionButtonWrapper: {
    flex: 1,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingBottom: 8,
  },
  header: { alignItems: 'flex-start', width: '100%', marginTop: 10 },
  displayName: { fontSize: 24, marginBottom: 2, letterSpacing: 0.1 },
  subText: { fontSize: 16, marginBottom: 2 },
  bio: { fontSize: 15, marginTop: 10, lineHeight: 20 },
  profileActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  details: { marginTop: 12 },
  metadataRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 4 },
  metadataEntry: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  metadataText: { fontSize: 15, lineHeight: 20, flexShrink: 1 },
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
  },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statNumber: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  statLabel: { fontSize: 15, lineHeight: 20 },
  // Error state layout
  errorTitle: { fontSize: 20 },
  errorContent: { justifyContent: 'center', alignItems: 'center' },
  errorText: { fontSize: 18, fontWeight: '600', textAlign: 'center' },
  errorSubtext: { fontSize: 14, textAlign: 'center' },
});

export default ProfileScreen;
