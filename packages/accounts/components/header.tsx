import React, { useMemo, useRef, useCallback } from 'react';
import { View, TouchableOpacity, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { BlurView } from 'expo-blur';
import { useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useTheme } from '@oxyhq/bloom/theme';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { LogoIcon , useOxy } from '@oxyhq/services';
import { Avatar } from '@oxyhq/bloom/avatar';
import { useScrollContext } from '@/contexts/scroll-context';
import { getAccountDisplayName, getNormalizedUserHandle } from '@oxyhq/core';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { darkenColor } from '@/utils/color-utils';
import { useTranslation } from '@/lib/i18n';
import Animated, { useAnimatedStyle, withTiming, useDerivedValue } from 'react-native-reanimated';

interface DrawerNavigation {
    openDrawer?: () => void;
    closeDrawer?: () => void;
    toggleDrawer?: () => void;
    dispatch?: (action: unknown) => void;
}

interface HeaderProps {
}

const DOUBLE_PRESS_DELAY = 300;

export function Header(_props: HeaderProps) {
    const navigation = useNavigation<DrawerNavigation>();
    const router = useRouter();
    const colors = useColors();
    const { mode } = useTheme();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const { isScrolled, scrollToTop, scrollY, scrollDirection } = useScrollContext();
    const isDesktop = Platform.OS === 'web' && width >= 768;
    const { t } = useTranslation();

    // The header avatar + name reflect the current account. A Google-style
    // account switch is a real session switch, so `user` already mirrors the
    // switched-into account in the chrome.
    const { user, oxyServices, showBottomSheet, isAuthenticated, refreshSessions } = useOxy();

    const lastPressRef = useRef<number>(0);
    const pressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const displayName = useMemo(
        () => user?.name?.displayName ?? getNormalizedUserHandle(user) ?? getAccountDisplayName(null),
        [user],
    );
    const avatarUrl = useMemo(() => {
        if (user?.avatar && oxyServices) {
            return oxyServices.getFileDownloadUrl(user.avatar, 'thumb');
        }
        return undefined;
    }, [user?.avatar, oxyServices]);

    const clearPressTimeout = useCallback(() => {
        if (pressTimeoutRef.current) {
            clearTimeout(pressTimeoutRef.current);
            pressTimeoutRef.current = null;
        }
        lastPressRef.current = 0;
    }, []);

    const handleAvatarPress = useCallback(() => {
        showBottomSheet?.('ManageAccount');
    }, [showBottomSheet]);

    const handleMenuPress = useCallback(() => {
        // Fallback: synthesize the DrawerActions.openDrawer payload inline so
        // we don't import from `@react-navigation/*` directly (expo-router 56
        // rejects direct react-navigation imports).
        if (navigation.openDrawer) {
            navigation.openDrawer();
            return;
        }
        navigation.dispatch?.({ type: 'OPEN_DRAWER' });
    }, [navigation]);

    const handleLogoPress = useCallback(() => {
        const now = Date.now();
        const timeSinceLastPress = now - lastPressRef.current;

        if (lastPressRef.current && timeSinceLastPress < DOUBLE_PRESS_DELAY) {
            // Double press detected
            clearPressTimeout();
            scrollToTop();
            refreshSessions?.().catch(console.error);
        } else {
            // Single press - navigate to home after delay
            lastPressRef.current = now;
            pressTimeoutRef.current = setTimeout(() => {
                router.push('/(tabs)');
                lastPressRef.current = 0;
            }, DOUBLE_PRESS_DELAY);
        }
    }, [router, scrollToTop, refreshSessions, clearPressTimeout]);

    const handlePressIn = useHapticPress();

    const handleLogoPressIn = useCallback(() => {
        handlePressIn();
    }, [handlePressIn]);

    const headerStyle = useMemo(() => [
        styles.header,
        {
            paddingTop: isDesktop ? 0 : insets.top + 4,
            paddingBottom: isDesktop ? 0 : 0,
            paddingHorizontal: isDesktop ? 16 : 10,
            borderBottomColor: colors.border,
            borderBottomWidth: isDesktop ? 0.5 : 0,
            ...(!isDesktop && {
                overflow: 'visible' as const,
            }),
        },
    ], [insets.top, colors.border, isDesktop]);

    // Track header visibility based on scroll
    const headerVisible = useDerivedValue(() => {
        const scrollThreshold = 10;

        // Always show header when at top
        if (scrollY.value < scrollThreshold) {
            return 1;
        }

        // Hide when scrolling down, show when scrolling up
        return scrollDirection.value === 'down' ? 0 : 1;
    }, []);

    // Animated styles for header slide/fade based on scroll
    // Mobile header height: safe area + top padding (4) + top row (36)
    const headerAnimatedStyle = useAnimatedStyle(() => {
        const headerHeight = isDesktop ? 64 : (insets.top + 4 + 36);
        const visible = headerVisible.value;

        return {
            transform: [{
                translateY: withTiming(visible === 1 ? 0 : -headerHeight, {
                    duration: 300
                })
            }],
            opacity: withTiming(visible, { duration: 300 }),
        };
    }, [isDesktop, insets.top]);

    const avatarSize = isDesktop ? 36 : 32;
    const avatarBorderRadius = avatarSize / 2;
    const avatarIconSize = isDesktop ? 20 : 18;

    return (
        <Animated.View
            style={[styles.headerContainer, headerAnimatedStyle]}
            pointerEvents="box-none"
        >
            <BlurView
                intensity={isScrolled ? 50 : 0}
                tint={mode === 'dark' ? 'dark' : 'light'}
                style={[headerStyle, !isDesktop && styles.headerColumn]}
            >
                <View style={styles.headerRow}>
                    <View style={[styles.topBarLeft, !isDesktop && styles.topBarLeftMobile]}>
                        {!isDesktop && (
                            <TouchableOpacity
                                onPressIn={handlePressIn}
                                onPress={handleMenuPress}
                                style={styles.menuButton}
                                accessibilityRole="button"
                                accessibilityLabel={t('a11y.menu')}
                                accessibilityHint={t('a11y.menuHint')}
                            >
                                <Ionicons name="menu" size={24} color={colors.text} />
                            </TouchableOpacity>
                        )}
                        {isDesktop && (
                            <TouchableOpacity
                                onPressIn={handleLogoPressIn}
                                onPress={handleLogoPress}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                                accessibilityLabel={t('a11y.logo')}
                                accessibilityHint={t('a11y.logoHint')}
                            >
                                <LogoIcon height={32} />
                            </TouchableOpacity>
                        )}
                    </View>

                    {!isDesktop && (
                        <View style={styles.logoCenterContainer}>
                            <TouchableOpacity
                                onPressIn={handleLogoPressIn}
                                onPress={handleLogoPress}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                                accessibilityLabel={t('a11y.logo')}
                                accessibilityHint={t('a11y.logoHint')}
                            >
                                <LogoIcon height={28} />
                            </TouchableOpacity>

                        </View>
                    )}

                    <View style={[styles.topBarRight, !isDesktop && styles.topBarRightMobile]}>
                        <TouchableOpacity
                            onPressIn={handlePressIn}
                            onPress={handleAvatarPress}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            accessibilityLabel={t('a11y.avatar')}
                            accessibilityHint={t('a11y.avatarHint')}
                        >
                            {isAuthenticated ? (
                                <Avatar name={displayName} source={avatarUrl} size={avatarSize} />
                            ) : (
                                <View style={[styles.userIconContainer, {
                                    backgroundColor: colors.sidebarIconPersonalInfo,
                                    width: avatarSize,
                                    height: avatarSize,
                                    borderRadius: avatarBorderRadius,
                                }]}>
                                    <MaterialCommunityIcons
                                        name="account-outline"
                                        size={avatarIconSize}
                                        color={darkenColor(colors.sidebarIconPersonalInfo)}
                                    />
                                </View>
                            )}
                        </TouchableOpacity>
                    </View>
                </View>
            </BlurView>
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    headerContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1100,
        elevation: 1100, // Ensure the header stays above scrollable content on Android
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1100,
        ...Platform.select({
            web: {
                overflow: 'hidden',
                height: 64,
            },
        }),
    },
    headerColumn: {
        flexDirection: 'column',
        alignItems: 'stretch',
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
    },
    menuButton: {
        padding: 6,
    },
    topBarLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    topBarLeftMobile: {
        flex: 1,
        justifyContent: 'flex-start',
        minWidth: 0,
    },
    logoCenterContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 0,
    },
    topBarRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    topBarRightMobile: {
        flex: 1,
        justifyContent: 'flex-end',
        minWidth: 0,
    },
    iconButton: {
        padding: 6,
        borderRadius: 20,
    },
    userIconContainer: {
        alignItems: 'center',
        justifyContent: 'center',
    },
});
