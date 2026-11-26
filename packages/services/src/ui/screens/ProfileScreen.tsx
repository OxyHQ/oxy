import type React from 'react';
import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { skip, useRecord } from '@oxy.so/bloom-data';
import type { BaseScreenProps } from '../types/navigation';
import { useTheme } from '@oxy.so/bloom/theme';
import { Button } from '@oxy.so/bloom/button';

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
import { profileCard } from '../data/account';
import { createTokenStyles } from '@oxy.so/bloom/theme';

interface ProfileScreenProps extends BaseScreenProps {
  userId: string;
  username?: string;
}

const AVATAR_SIZE = 96;
const INFO_ICON_SIZE = 18;

const ProfileScreen: React.FC<ProfileScreenProps> = ({ userId, username, navigate }) => {
  const themed = useThemedStyles();
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

  // Profile + reputation in ONE read (no data-fetch effect). The reputation
  // read swallows its own failure; only the profile read can fail it, and for
  // MY OWN profile a failed read falls back to the active-account snapshot
  // instead of erroring. Each account has its own store, so a switch reads again.
  const profileView = useRecord(
    profileCard,
    ...(userId ? ([oxyServices, userId, isOwnProfile ? currentUser : null] as const) : [skip]),
  );

  const profile = profileView.value?.profile ?? (isOwnProfile ? currentUser : null);
  const reputationTotal = profileView.value?.reputationTotal ?? null;
  const profileFailed = profileView.status === 'error';
  const profileError = profileView.error;

  // Friendly, status-aware error copy derived from the query error (no effect).
  const error = useMemo<string | null>(() => {
    if (!userId) return 'No user ID provided';
    if (!profileFailed) return null;
    const err = profileError;
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
  }, [userId, profileFailed, profileError, isOwnProfile]);

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
      <View style={[styles.container, styles.errorContent]}>
        <Ionicons name="alert-circle" size={48} color={bloomTheme.colors.error} />
        <Text role="heading" aria-level={2} style={[themed.text, styles.errorTitle]}>
          {t('profile.errorTitle') || 'Profile Error'}
        </Text>
        <Text style={[themed.text2, styles.errorText]}>{error}</Text>
        <Text style={[themed.mutedText, styles.errorSubtext]}>
          {t('profile.errorSubtext') ||
            "This could happen if the user doesn't exist or the profile service is unavailable."}
        </Text>
      </View>
    );
  }

  if (!profile && profileView.isLoading) {
    return (
      <View
        testID="profile-skeleton"
        accessibilityLabel={t('common.loading')}
        accessibilityState={{ busy: true }}
        style={styles.scrollContainer}
      >
        <CoverHeader>
          <View style={[styles.section, styles.avatarRow]}>
            <Skeleton.Circle size={AVATAR_SIZE} />
            <Skeleton.Box width={88} height={32} borderRadius={16} />
          </View>
          <View style={[styles.stack, styles.header]}>
            <Skeleton.Box width={180} height={28} />
            <Skeleton.Box width={110} height={18} />
            <Skeleton.Box width="100%" height={18} style={{ marginTop: 10 }} />
            <Skeleton.Box width="75%" height={18} />
          </View>
        </CoverHeader>
        <View style={[styles.stack2, styles.details]}>
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
        <View style={[styles.section, styles.avatarRow]}>
          <View
            style={[
              styles.container2,
              styles.avatarWrapper,
              { borderColor: surfaceFill, backgroundColor: surfaceFill },
            ]}
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
                <Button
                  appearance="outline"
                  tone="neutral"
                  icon={RiSettings3Line}
                  accessibilityLabel={t('accountMenu.settings') || 'Settings'}
                  onPress={() => navigate?.('Preferences')}
                />
              </View>
            ) : (
              <FollowButton
                userId={userId}
                onFollowChange={(isFollowing) => {
                  // The follow writes the counts onto `User`, which this screen reads
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
        <View style={[styles.section, styles.header]}>
          <Text role="heading" aria-level={2} style={[themed.text2, styles.displayName]}>
            {displayName}
          </Text>
          {profile?.username && (
            <Text style={[themed.mutedText, styles.subText]}>@{profile.username}</Text>
          )}
          {/* Bio */}
          {profile?.bio ? <Text style={[themed.text2, styles.bio]}>{profile.bio}</Text> : null}
        </View>
      </CoverHeader>

      <View style={[styles.section, styles.details]}>
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
          <Button
            appearance="plain"
            linkTone="primary"
            size="sm"
            href={websiteUrl}
            style={{ alignSelf: 'flex-start', paddingLeft: 0, paddingRight: 0 }}
            target="_blank"
            rel="noopener noreferrer"
            icon={<Ionicons name="link-outline" size={INFO_ICON_SIZE} />}
          >
            {profile?.website}
          </Button>
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

  container: { gap: 12, paddingHorizontal: 32, paddingVertical: 40 },
  section: { paddingHorizontal: 20 },
  stack: { gap: 8, paddingHorizontal: 20 },
  stack2: { gap: 12, paddingHorizontal: 20 },
  container2: { borderRadius: 9999 },
});

export default ProfileScreen;

const useThemedStyles = createTokenStyles((t) => ({
  text: { textAlign: 'center', color: t.foreground },
  text2: { color: t.foreground },
  mutedText: { color: t.mutedForeground },
}));
