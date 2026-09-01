import type React from 'react';
import { useMemo } from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { BaseScreenProps } from '../types/navigation';
import { useTheme } from '@oxyhq/bloom/theme';
import { Button } from '@oxyhq/bloom/button';
import { H2, Text } from '@oxyhq/bloom/typography';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { Avatar } from '@oxyhq/bloom/avatar';
import FollowButton from '../components/FollowButton';
import { useFollow } from '../hooks/useFollow';
import Ionicons from '../icons/Ionicons';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/OxyContext';
import { getNormalizedUserHandle, logger, normalizeProfileLinks } from '@oxyhq/core';
import { extractErrorMessage } from '../utils/errorHandlers';

interface ProfileScreenProps extends BaseScreenProps {
    userId: string;
    username?: string;
}

const AVATAR_SIZE = 96;
const BANNER_HEIGHT = 160;
const AVATAR_OVERLAP = -56;
const INFO_ICON_SIZE = 18;

const ProfileScreen: React.FC<ProfileScreenProps> = ({ userId, username, theme, goBack, navigate }) => {
    // Use useOxy() hook for OxyContext values. "Me" for own-profile detection
    // and the own-profile fallback is the ACTIVE account (the account switched
    // into), so previewing my profile while switched into an org/project/bot
    // resolves "this is mine" against that account, not the session owner.
    const { oxyServices, user: currentUser } = useOxy();

    // Use the follow hook for real follower data
    const {
        followerCount,
        followingCount,
        isLoadingCounts,
    } = useFollow(userId);

    const bloomTheme = useTheme();
    const { t } = useI18n();

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
            // Follower/following counts come from the `useFollow` hook; the stats
            // read is kept for parity (it warms server-side counters) but its
            // result is not surfaced in this view, so it is not bound.
            const [profileRes, reputationRes] = await Promise.all([
                oxyServices.getUserById(userId).catch((err: unknown) => {
                    if (isOwnProfile) return currentUser;
                    logger.error(
                        'Profile loading error',
                        err instanceof Error ? err : new Error(String(err)),
                        { component: 'ProfileScreen' },
                    );
                    throw err;
                }),
                (isOwnProfile
                    ? oxyServices.getMyReputationBalance()
                    : oxyServices.getReputationBalance(userId))
                    .then((balance): { total: number | undefined } => ({ total: balance.total }))
                    .catch((): { total: number | undefined } => ({ total: undefined })),
                oxyServices.getUserStats
                    ? oxyServices.getUserStats(userId).catch(() => ({ postCount: 0, commentCount: 0 }))
                    : Promise.resolve({ postCount: 0, commentCount: 0 }),
            ]);
            if (!profileRes) {
                throw new Error('Profile data is not available');
            }
            return {
                profile: profileRes,
                reputationTotal: typeof reputationRes.total === 'number' ? reputationRes.total : null,
                links: normalizeProfileLinks(profileRes.linksMetadata, profileRes.links),
            };
        },
    });

    const profile = profileQuery.data?.profile ?? null;
    const reputationTotal = profileQuery.data?.reputationTotal ?? null;
    const links = profileQuery.data?.links ?? [];
    const isLoading = !!userId && profileQuery.isLoading;

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

    // Display name: the loaded profile's, else the passed handle. Also the nav-bar
    // title (a stable "Profile" fallback before it resolves), so the banner +
    // overlapping avatar scroll as content UNDER the shared gradient nav bar.
    // `onImage` tone keeps the title + close legible over the colored banner.
    // Ends in a string, deliberately: `getNormalizedUserHandle` answers `null` for a
    // user it cannot normalise, and letting that null travel makes this `string | null`
    // — which does not satisfy `Avatar.name` and does not typecheck. Empty is the honest
    // bottom of the chain and every reader below already treats it as falsy
    // (`displayName || t('profile.title')`), so nothing renders a literal "null".
    const displayName = profile
        ? (profile.name?.displayName ?? getNormalizedUserHandle(profile) ?? '')
        : username || '';
    useSurfaceHeader({
        title: displayName || t('profile.title'),
        largeTitle: false,
        tone: 'onImage',
    });

    if (isLoading) {
        return (
            <View className="items-center py-space-40">
                <ActivityIndicator size="large" color={bloomTheme.colors.primary} />
            </View>
        );
    }

    if (error) {
        // The shared nav header owns back/close; the error body is just the alert.
        return (
            <View style={styles.errorContent} className="px-space-32 gap-space-12 py-space-40">
                <Ionicons name="alert-circle" size={48} color={bloomTheme.colors.error} />
                <H2 style={styles.errorTitle} className="text-text text-center">
                    {t('profile.errorTitle') || 'Profile Error'}
                </H2>
                <Text style={styles.errorText} className="text-text">{error}</Text>
                <Text style={styles.errorSubtext} className="text-text-secondary">
                    {t('profile.errorSubtext') || "This could happen if the user doesn't exist or the profile service is unavailable."}
                </Text>
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

    return (
        <View style={styles.scrollContainer}>
                {/* Banner Image */}
                <View style={styles.bannerContainer} className="bg-fill-brand/20">
                    <View style={styles.flex} className="bg-fill-brand" />
                </View>
                {/* Avatar overlapping banner */}
                <View style={styles.avatarRow} className="px-screen-margin">
                    <View style={styles.avatarWrapper} className="border-bg bg-bg rounded-radius-max">
                        <Avatar
                            // `getFileDownloadUrl` answers `null` for a reference it cannot
                            // resolve, and `Avatar.source` takes `undefined` for "no picture" —
                            // the two spellings of absent do not meet, so the coalesce is the
                            // whole fix. Without it this file does not typecheck, which blocks
                            // `bun run build` and therefore every publish of this package.
                            source={
                                profile?.avatar
                                    ? (oxyServices.getFileDownloadUrl(profile.avatar, 'thumb') ?? undefined)
                                    : undefined
                            }
                            name={displayName}
                            size={AVATAR_SIZE}
                        />
                    </View>
                    {/* Conditional Action Button */}
                    <View style={styles.actionButtonWrapper}>
                        {isOwnProfile ? (
                            <Button
                                variant="secondary"
                                size="small"
                                onPress={() => navigate?.('ManageAccount')}
                            >
                                {t('editProfile.title') || 'Edit Profile'}
                            </Button>
                        ) : (
                            <FollowButton
                                userId={userId}
                                onFollowChange={(isFollowing) => {
                                    // The follow button will automatically update counts via Zustand
                                    if (__DEV__) {
                                        logger.debug(`Follow status changed: ${isFollowing}`, { component: 'ProfileScreen' });
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
                        <Text style={styles.subText} className="text-text-secondary">@{profile.username}</Text>
                    )}
                    {/* Bio */}
                    <Text style={styles.bio} className="text-text">{profile?.bio || (t('profile.noBio') || 'This user has no bio yet.')}</Text>
                </View>

                {/* Info Grid as a settings list group */}
                <View className="px-screen-margin">
                <SettingsListGroup>
                    {profile?.createdAt && (
                        <SettingsListItem
                            icon={<Ionicons name="calendar-outline" size={INFO_ICON_SIZE} color={bloomTheme.colors.textSecondary} />}
                            title={t('profile.joinedOn', { date: new Date(profile.createdAt).toLocaleDateString() }) || `Joined ${new Date(profile.createdAt).toLocaleDateString()}`}
                            showChevron={false}
                        />
                    )}
                    {primaryLocation && (
                        <SettingsListItem
                            icon={<Ionicons name="location-outline" size={INFO_ICON_SIZE} color={bloomTheme.colors.textSecondary} />}
                            title={primaryLocation}
                            showChevron={false}
                        />
                    )}
                    {profile?.website && (
                        <SettingsListItem
                            icon={<Ionicons name="globe-outline" size={INFO_ICON_SIZE} color={bloomTheme.colors.textSecondary} />}
                            title={profile.website}
                            showChevron={false}
                        />
                    )}
                    {profile && 'company' in profile && typeof profile.company === 'string' && profile.company && (
                        <SettingsListItem
                            icon={<Ionicons name="business-outline" size={INFO_ICON_SIZE} color={bloomTheme.colors.textSecondary} />}
                            title={profile.company}
                            showChevron={false}
                        />
                    )}
                    {profile && 'jobTitle' in profile && typeof profile.jobTitle === 'string' && profile.jobTitle && (
                        <SettingsListItem
                            icon={<Ionicons name="briefcase-outline" size={INFO_ICON_SIZE} color={bloomTheme.colors.textSecondary} />}
                            title={profile.jobTitle}
                            showChevron={false}
                        />
                    )}
                    {profile && 'education' in profile && typeof profile.education === 'string' && profile.education && (
                        <SettingsListItem
                            icon={<Ionicons name="school-outline" size={INFO_ICON_SIZE} color={bloomTheme.colors.textSecondary} />}
                            title={profile.education}
                            showChevron={false}
                        />
                    )}
                    {profile && 'birthday' in profile && typeof profile.birthday === 'string' && profile.birthday && (
                        <SettingsListItem
                            icon={<Ionicons name="gift-outline" size={INFO_ICON_SIZE} color={bloomTheme.colors.textSecondary} />}
                            title={t('profile.bornOn', { date: new Date(profile.birthday).toLocaleDateString() }) || `Born ${new Date(profile.birthday).toLocaleDateString()}`}
                            showChevron={false}
                        />
                    )}
                    {links.length > 0 && (
                        <SettingsListItem
                            icon={<Ionicons name="link-outline" size={INFO_ICON_SIZE} color={bloomTheme.colors.textSecondary} />}
                            title={links[0].url}
                            value={links.length > 1 ? (t('profile.more', { count: links.length - 1 }) || `+ ${links.length - 1} more`) : undefined}
                            onPress={() => navigate?.('UserLinks', { userId, links })}
                        />
                    )}
                </SettingsListGroup>
                </View>

                {/* All Stats in one row */}
                <View style={styles.statsRow} className="px-screen-margin">
                    <View style={styles.statItem}>
                        <Text style={styles.statAmount} className="text-text">{reputationTotal !== null && reputationTotal !== undefined ? reputationTotal : '--'}</Text>
                        <Text style={styles.statLabel} className="text-text-secondary">{t('profile.reputation') || 'Reputation'}</Text>
                    </View>
                    <View style={styles.statItem}>
                        {isLoadingCounts ? (
                            <ActivityIndicator size="small" color={bloomTheme.colors.text} />
                        ) : (
                            <Text style={styles.statAmount} className="text-text">{followerCount !== null ? followerCount : '--'}</Text>
                        )}
                        <Text style={styles.statLabel} className="text-text-secondary">{t('profile.followers') || 'Followers'}</Text>
                    </View>
                    <View style={styles.statItem}>
                        {isLoadingCounts ? (
                            <ActivityIndicator size="small" color={bloomTheme.colors.text} />
                        ) : (
                            <Text style={styles.statAmount} className="text-text">{followingCount !== null ? followingCount : '--'}</Text>
                        )}
                        <Text style={styles.statLabel} className="text-text-secondary">{t('profile.following') || 'Following'}</Text>
                    </View>
                </View>
        </View>
    );
};

// Layout-only styles: flex, dimensions, and the measured banner/avatar overlap
// that no token class can express. Colors, spacing, radius, and typography roles
// live on Bloom components + NativeWind token classes.
const styles = StyleSheet.create({
    flex: { flex: 1 },
    scrollContainer: { alignItems: 'stretch', paddingBottom: 40 },
    bannerContainer: { height: BANNER_HEIGHT, position: 'relative', overflow: 'hidden' },
    avatarRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        marginTop: AVATAR_OVERLAP,
        justifyContent: 'space-between',
        zIndex: 2,
    },
    avatarWrapper: { borderWidth: 5, overflow: 'hidden' },
    actionButtonWrapper: { flex: 1, alignItems: 'flex-end', justifyContent: 'flex-end', paddingBottom: 8 },
    header: { alignItems: 'flex-start', width: '100%', marginTop: 10 },
    displayName: { fontSize: 24, marginBottom: 2, letterSpacing: 0.1 },
    subText: { fontSize: 16, marginBottom: 2 },
    bio: { fontSize: 16, marginTop: 10, lineHeight: 22 },
    statsRow: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 14,
        justifyContent: 'space-between',
    },
    statItem: { flex: 1, alignItems: 'center', minWidth: 50, marginBottom: 12 },
    statLabel: { fontSize: 14, marginBottom: 2, textAlign: 'center' },
    statAmount: { fontSize: 24, fontWeight: 'bold', textAlign: 'center', letterSpacing: 0.2 },
    // Error state layout
    errorTitle: { fontSize: 20 },
    errorContent: { justifyContent: 'center', alignItems: 'center' },
    errorText: { fontSize: 18, fontWeight: '600', textAlign: 'center' },
    errorSubtext: { fontSize: 14, textAlign: 'center' },
});

export default ProfileScreen;
