import type React from 'react';
import { useMemo, useState, useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import type { BaseScreenProps } from '../../types/navigation';
import { useSurfaceHeader } from '../../hooks/useSurfaceHeader';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@oxyhq/bloom/theme';
import { H1, H4, H5, Text } from '@oxyhq/bloom/typography';
import { useI18n } from '../../hooks/useI18n';
import { useOxy } from '../../context/OxyContext';
import { darkenColor, lightenColor } from '../../utils/colorUtils';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface Achievement {
    id: string;
    name: string;
    description: string;
    category: 'milestone' | 'streak' | 'contribution' | 'special';
    icon: IoniconName;
    /** Identity tint for the unlocked badge — part of the achievement data model. */
    iconColor: string;
    unlocked: boolean;
    unlockedDate?: string;
    rarity: 'common' | 'rare' | 'epic' | 'legendary';
}

/**
 * Per-achievement identity tints. Like the trust-tier palette in `trustTier.ts`,
 * these are data, not theme surfaces — they brand each badge regardless of theme.
 */
const ACHIEVEMENT_TINT = {
    gray: '#8E8E93',
    green: '#34C759',
    blue: '#007AFF',
    orange: '#FF9500',
    purple: '#AF52DE',
    pink: '#FF2D55',
    gold: '#FFD700',
    red: '#FF3B30',
    indigo: '#5E5CE6',
} as const;

/** Rarity-tier identity tints for the corner rarity accent. */
const RARITY_TINT: Record<Achievement['rarity'], string> = {
    legendary: ACHIEVEMENT_TINT.gold,
    epic: ACHIEVEMENT_TINT.purple,
    rare: ACHIEVEMENT_TINT.blue,
    common: '',
};

/** Contrast-locked foreground for icons/value text painted over a colored badge fill. */
const BADGE_ON_COLOR = '#FFFFFF';

/** Reputation thresholds that unlock each milestone, and the value shown on its badge. */
const ACHIEVEMENT_VALUE: Record<string, number> = {
    'first-step': 1,
    novice: 10,
    contributor: 50,
    'rising-star': 100,
    'early-adopter': 200,
    'community-hero': 500,
    legend: 1000,
    phoenix: 2500,
    unstoppable: 5000,
    helper: 10,
    'streak-master': 7,
};

const BADGE_BORDER_WIDTH = 5;
const BADGE_GLOW_OPACITY = 0.3;
const BADGE_DARKEN = 0.45;
const BADGE_LIGHTEN = 0.25;
const RARITY_DARKEN = 0.4;
const ACCENT_LIGHTEN = 0.1;
const LOCKED_OPACITY = 0.5;

const TrustRewardsScreen: React.FC<BaseScreenProps> = () => {
    const { t } = useI18n();
    // Reputation/trust is the ACTIVE account's standing (the org/project/bot
    // when switched, else the personal user).
    const { user, oxyServices, isAuthenticated } = useOxy();

    useSurfaceHeader({
        title: t('trust.rewards.title') || 'Trust Rewards',
        subtitle: t('trust.rewards.subtitle') || 'Unlock special features and recognition',
    });
    const [reputationTotal, setReputationTotal] = useState<number>(0);
    const [, setIsLoading] = useState(true);

    const bloomTheme = useTheme();
    const colors = bloomTheme.colors;

    useEffect(() => {
        if (!user || !isAuthenticated) {
            setIsLoading(false);
            return;
        }
        setIsLoading(true);
        oxyServices.getReputationBalance(user.id)
            .then((balance) => {
                setReputationTotal(balance.total || 0);
            })
            .catch(() => {
                setReputationTotal(0);
            })
            .finally(() => setIsLoading(false));
    }, [user, isAuthenticated, oxyServices]);

    const achievements: Achievement[] = useMemo(() => [
        {
            id: 'first-step',
            name: t('trust.achievements.firstStep') || 'First Step',
            description: t('trust.achievements.firstStepDesc') || 'Earned your first reputation point',
            category: 'milestone',
            icon: 'footsteps',
            iconColor: ACHIEVEMENT_TINT.gray,
            unlocked: reputationTotal >= 1,
            rarity: 'common',
        },
        {
            id: 'novice',
            name: t('trust.achievements.novice') || 'Novice',
            description: t('trust.achievements.noviceDesc') || 'Reached 10 reputation points',
            category: 'milestone',
            icon: 'leaf',
            iconColor: ACHIEVEMENT_TINT.green,
            unlocked: reputationTotal >= 10,
            rarity: 'common',
        },
        {
            id: 'contributor',
            name: t('trust.achievements.contributor') || 'Contributor',
            description: t('trust.achievements.contributorDesc') || 'Reached 50 reputation points',
            category: 'contribution',
            icon: 'people',
            iconColor: ACHIEVEMENT_TINT.blue,
            unlocked: reputationTotal >= 50,
            rarity: 'common',
        },
        {
            id: 'rising-star',
            name: t('trust.achievements.risingStar') || 'Rising Star',
            description: t('trust.achievements.risingStarDesc') || 'Reached 100 reputation points',
            category: 'milestone',
            icon: 'star',
            iconColor: ACHIEVEMENT_TINT.orange,
            unlocked: reputationTotal >= 100,
            rarity: 'rare',
        },
        {
            id: 'early-adopter',
            name: t('trust.achievements.earlyAdopter') || 'Early Adopter',
            description: t('trust.achievements.earlyAdopterDesc') || 'Been part of the community from the start',
            category: 'special',
            icon: 'rocket',
            iconColor: ACHIEVEMENT_TINT.purple,
            unlocked: reputationTotal >= 200,
            rarity: 'rare',
        },
        {
            id: 'community-hero',
            name: t('trust.achievements.communityHero') || 'Community Hero',
            description: t('trust.achievements.communityHeroDesc') || 'Reached 500 reputation points',
            category: 'contribution',
            icon: 'shield',
            iconColor: ACHIEVEMENT_TINT.pink,
            unlocked: reputationTotal >= 500,
            rarity: 'epic',
        },
        {
            id: 'legend',
            name: t('trust.achievements.legend') || 'Legend',
            description: t('trust.achievements.legendDesc') || 'Reached 1000 reputation points',
            category: 'milestone',
            icon: 'trophy',
            iconColor: ACHIEVEMENT_TINT.gold,
            unlocked: reputationTotal >= 1000,
            rarity: 'legendary',
        },
        {
            id: 'phoenix',
            name: t('trust.achievements.phoenix') || 'Phoenix',
            description: t('trust.achievements.phoenixDesc') || 'Reached 2500 reputation points',
            category: 'milestone',
            icon: 'flame',
            iconColor: ACHIEVEMENT_TINT.red,
            unlocked: reputationTotal >= 2500,
            rarity: 'legendary',
        },
        {
            id: 'unstoppable',
            name: t('trust.achievements.unstoppable') || 'Unstoppable',
            description: t('trust.achievements.unstoppableDesc') || 'Reached 5000 reputation points',
            category: 'milestone',
            icon: 'infinite',
            iconColor: ACHIEVEMENT_TINT.indigo,
            unlocked: reputationTotal >= 5000,
            rarity: 'legendary',
        },
        {
            id: 'bug-hunter',
            name: t('trust.achievements.bugHunter') || 'Bug Hunter',
            description: t('trust.achievements.bugHunterDesc') || 'Reported helpful bugs',
            category: 'contribution',
            icon: 'bug',
            iconColor: ACHIEVEMENT_TINT.orange,
            unlocked: false,
            rarity: 'rare',
        },
        {
            id: 'helper',
            name: t('trust.achievements.helper') || 'Helper',
            description: t('trust.achievements.helperDesc') || 'Helped 10 users',
            category: 'contribution',
            icon: 'hand-left',
            iconColor: ACHIEVEMENT_TINT.green,
            unlocked: false,
            rarity: 'common',
        },
        {
            id: 'streak-master',
            name: t('trust.achievements.streakMaster') || 'Streak Master',
            description: t('trust.achievements.streakMasterDesc') || '7 day activity streak',
            category: 'streak',
            icon: 'flash',
            iconColor: ACHIEVEMENT_TINT.gold,
            unlocked: false,
            rarity: 'epic',
        },
    ], [t, reputationTotal]);

    const unlockedAchievements = achievements.filter(a => a.unlocked);
    const lockedAchievements = achievements.filter(a => !a.unlocked);

    const getRarityColor = (rarity: Achievement['rarity']): string =>
        RARITY_TINT[rarity] || colors.textTertiary;

    const getAchievementValue = (achievement: Achievement): number | null =>
        ACHIEVEMENT_VALUE[achievement.id] ?? null;

    const renderAchievement = (achievement: Achievement) => {
        const rarityColor = getRarityColor(achievement.rarity);
        const isLocked = !achievement.unlocked;
        const achievementValue = getAchievementValue(achievement);

        // Two-tone colors: darker for borders/shadow, lighter for highlights.
        // Use the achievement identity tint for unlocked badges, neutral for locked.
        const baseColor = isLocked ? colors.textTertiary : (achievement.iconColor || colors.textTertiary);
        const darkTone = darkenColor(baseColor, BADGE_DARKEN);
        const lightTone = lightenColor(baseColor, BADGE_LIGHTEN);
        const mediumTone = baseColor;

        return (
            <View
                key={achievement.id}
                className="bg-fill rounded-radius-20 items-center"
                style={styles.achievementCard}
            >
                <View style={styles.badgeContainer}>
                    {/* Outer glow effect - larger and softer */}
                    {!isLocked && (
                        <View
                            style={[
                                styles.badgeGlow,
                                styles.badgeOrganic,
                                {
                                    backgroundColor: darkTone,
                                    opacity: BADGE_GLOW_OPACITY,
                                },
                            ]}
                        />
                    )}

                    {/* Main badge with two-tone effect */}
                    <View
                        style={[
                            styles.badgeMain,
                            styles.badgeOrganic,
                            {
                                backgroundColor: isLocked ? colors.border : mediumTone,
                                borderColor: darkTone,
                                borderWidth: BADGE_BORDER_WIDTH,
                                shadowColor: darkTone,
                            },
                        ]}
                    >
                        {/* Gradient-like highlight layer (lighter tone on top half) */}
                        {!isLocked && (
                            <>
                                <View
                                    style={[
                                        styles.badgeHighlight,
                                        { backgroundColor: lightTone },
                                    ]}
                                />
                                {/* Additional highlight for more depth */}
                                <View
                                    style={[
                                        styles.badgeHighlightAccent,
                                        { backgroundColor: lightenColor(lightTone, ACCENT_LIGHTEN) },
                                    ]}
                                />
                            </>
                        )}

                        {/* Icon container - positioned in upper area */}
                        <View style={styles.badgeIconContainer}>
                            {isLocked ? (
                                <Ionicons name="lock-closed" size={40} color={colors.textTertiary} />
                            ) : (
                                <Ionicons name={achievement.icon} size={40} color={BADGE_ON_COLOR} />
                            )}
                        </View>

                        {/* Achievement value number - large and prominent at bottom */}
                        {achievementValue !== null && !isLocked && (
                            <View style={styles.badgeValueContainer}>
                                <Text
                                    style={[
                                        styles.badgeValueText,
                                        {
                                            color: lightTone,
                                            textShadowColor: darkTone,
                                        },
                                    ]}
                                >
                                    {achievementValue}
                                </Text>
                            </View>
                        )}
                    </View>

                    {/* Rarity badge - small accent in corner */}
                    {achievement.unlocked && (
                        <View
                            style={[
                                styles.rarityBadge,
                                { backgroundColor: rarityColor, borderColor: darkenColor(rarityColor, RARITY_DARKEN) },
                            ]}
                        >
                            <Text style={[styles.rarityText, { color: BADGE_ON_COLOR }]}>
                                {achievement.rarity[0].toUpperCase()}
                            </Text>
                        </View>
                    )}
                </View>

                <H5
                    className="text-text text-center"
                    style={isLocked ? styles.lockedDimmed : undefined}
                    numberOfLines={2}
                >
                    {achievement.name}
                </H5>
                <Text
                    className="text-text-tertiary text-center text-xs mt-space-2"
                    style={isLocked ? styles.lockedDimmed : undefined}
                >
                    {achievement.description}
                </Text>
            </View>
        );
    };

    if (!isAuthenticated) {
        return (
                <View className="items-center justify-center px-screen-margin py-space-40">
                    <Text className="text-text text-base text-center">
                        {t('common.status.notSignedIn') || 'Not signed in'}
                    </Text>
                </View>
        );
    }

    const progressRatio = achievements.length > 0
        ? unlockedAchievements.length / achievements.length
        : 0;

    return (
            <View className="px-screen-margin pt-space-20 pb-space-40">
                {/* Stats Header */}
                <View className="bg-fill rounded-radius-20 p-space-20 mb-space-24">
                    <View className="flex-row justify-between items-center mb-space-16">
                        <View>
                            <H1 className="text-text" style={{ color: colors.primary }}>
                                {reputationTotal}
                            </H1>
                            <Text className="text-text-tertiary text-sm">
                                {t('trust.center.balance') || 'Reputation Points'}
                            </Text>
                        </View>
                        <View className="items-end">
                            <H1 className="text-text" style={{ color: colors.primary }}>
                                {unlockedAchievements.length}
                            </H1>
                            <Text className="text-text-tertiary text-sm">
                                {t('trust.achievements.unlocked') || 'Achievements'}
                            </Text>
                        </View>
                    </View>
                    <View className="mt-space-8">
                        <View
                            className="rounded-radius-full overflow-hidden mb-space-8"
                            style={[styles.progressBar, { backgroundColor: colors.border }]}
                        >
                            <View
                                className="rounded-radius-full"
                                style={[
                                    styles.progressBarFill,
                                    {
                                        width: `${progressRatio * 100}%`,
                                        backgroundColor: colors.primary,
                                    },
                                ]}
                            />
                        </View>
                        <Text className="text-text-tertiary text-xs text-right">
                            {unlockedAchievements.length} / {achievements.length}
                        </Text>
                    </View>
                </View>

                {/* Unlocked Achievements */}
                {unlockedAchievements.length > 0 && (
                    <>
                        <H4 className="text-text mt-space-8">
                            {t('trust.achievements.unlocked') || 'Unlocked Achievements'}
                        </H4>
                        <View style={styles.achievementsGrid}>
                            {unlockedAchievements.map(achievement => renderAchievement(achievement))}
                        </View>
                    </>
                )}

                {/* Locked Achievements */}
                {lockedAchievements.length > 0 && (
                    <>
                        <H4 className="text-text mt-space-8">
                            {t('trust.achievements.locked') || 'Locked Achievements'}
                        </H4>
                        <View style={styles.achievementsGrid}>
                            {lockedAchievements.map(achievement => renderAchievement(achievement))}
                        </View>
                    </>
                )}
            </View>
    );
};

// Measured/positioned layout only — no color, no theme surfaces.
const styles = StyleSheet.create({
    lockedDimmed: {
        opacity: LOCKED_OPACITY,
    },
    progressBar: {
        height: 8,
    },
    progressBarFill: {
        height: '100%',
    },
    achievementsGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 20,
        marginBottom: 24,
        justifyContent: 'space-between',
    },
    achievementCard: {
        width: '47%',
        minWidth: 140,
        padding: 20,
        paddingTop: 24,
    },
    badgeContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 12,
        position: 'relative',
        width: 120,
        height: 120,
    },
    badgeGlow: {
        position: 'absolute',
        width: 135,
        height: 135,
        borderRadius: 67.5,
        shadowOffset: { width: 0, height: 6 },
        shadowRadius: 15,
        shadowOpacity: 0.4,
        elevation: 10,
    },
    badgeOrganic: {
        width: 120,
        height: 120,
        // More organic blob shape with varied border radius (like Duolingo)
        borderTopLeftRadius: 48,
        borderTopRightRadius: 52,
        borderBottomLeftRadius: 52,
        borderBottomRightRadius: 48,
        alignItems: 'center',
        justifyContent: 'center',
    },
    badgeMain: {
        position: 'absolute',
        shadowOffset: { width: 0, height: 6 },
        shadowRadius: 12,
        shadowOpacity: 0.5,
        elevation: 8,
    },
    badgeHighlight: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: '50%',
        borderTopLeftRadius: 48,
        borderTopRightRadius: 52,
        opacity: 0.6,
    },
    badgeHighlightAccent: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: '30%',
        borderTopLeftRadius: 48,
        borderTopRightRadius: 52,
        opacity: 0.3,
    },
    badgeIconContainer: {
        position: 'absolute',
        top: 8,
        left: 0,
        right: 0,
        alignItems: 'center',
        justifyContent: 'flex-start',
        zIndex: 10,
        paddingTop: 12,
    },
    badgeValueContainer: {
        position: 'absolute',
        bottom: 8,
        left: 0,
        right: 0,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
    },
    badgeValueText: {
        fontSize: 32,
        fontWeight: 'bold',
        textShadowOffset: { width: 0, height: 2 },
        textShadowRadius: 4,
        letterSpacing: -1,
    },
    rarityBadge: {
        position: 'absolute',
        top: -6,
        right: -6,
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 3,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.4,
        shadowRadius: 4,
        elevation: 5,
    },
    rarityText: {
        fontSize: 14,
        fontWeight: 'bold',
    },
});

export default TrustRewardsScreen;
