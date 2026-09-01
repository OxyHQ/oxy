import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    StyleSheet,
    Platform,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { View, Pressable } from 'react-native-css/components';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Avatar } from '@oxyhq/bloom/avatar';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { Text } from '@oxyhq/bloom/typography';
import { useTheme } from '@oxyhq/bloom/theme';
import { getAccountDisplayName, getAccountFallbackHandle } from '@oxyhq/core';
import { useAuth } from '../hooks/useAuth';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { registerAccountDialogConsumerHooks } from '../navigation/accountDialogManager';

const isWeb = Platform.OS === 'web';

/**
 * Web-only Bluesky-style hover animation timings, mirrored from
 * `social-app/src/view/shell/desktop/LeftNav.tsx`. The row background and the
 * name/handle/chevron opacity cross-fade quickly; the avatar shrink+slide is
 * slower and more deliberate. A short delay on the LEAVE transition keeps the
 * row from flickering when the pointer crosses a child boundary.
 */
const BG_TRANSITION_MS = 150;
const AVATAR_TRANSITION_MS = 250;
const OPACITY_TRANSITION_MS = 150;
const LEAVE_DELAY_MS = 50;

/** Shrunk-avatar scale on hover, matching Bluesky's `scale: 2/3`. */
const ACTIVE_AVATAR_SCALE = 2 / 3;

/**
 * Reads the OS "reduce motion" preference on web. Guards `window`/`matchMedia`
 * so it is safe during SSR and on native (where it is never called). When
 * reduced motion is on, the avatar transform snaps instead of transitioning.
 */
const prefersReducedMotion = (): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

export interface ProfileButtonProps {
    /**
     * Expanded row (avatar + name + handle + chevron) when `true` (default), or a
     * bare avatar-only trigger when `false` (collapsed sidebar).
     */
    expanded?: boolean;
    /**
     * Avatar diameter in px. Defaults to 40 when expanded, 32 when collapsed.
     */
    avatarSize?: number;
    /** Navigate to the "Manage account" surface (settings). */
    onNavigateManage?: () => void;
    /** Start the add-account / sign-in flow for an additional account. */
    onAddAccount?: () => void;
    /** Optional: navigate to the signed-in user's own profile. */
    onNavigateProfile?: () => void;
    /**
     * Retained for source compatibility. The trigger now opens the unified
     * `OxyAccountDialogScreen` (a centered / bottom-sheet modal) rather than an
     * anchored popover, so popover placement no longer applies.
     */
    placement?: 'up' | 'down' | 'auto';
    /**
     * Extra className applied to the outer trigger. Kept for NativeWind consumers
     * that layer utility classes on top; the component's own layout is driven by
     * `StyleSheet` so it renders correctly with or without NativeWind.
     */
    className?: string;
    /** Extra style applied to the outer trigger. */
    style?: StyleProp<ViewStyle>;
}

/**
 * Self-contained sidebar account trigger, modeled on Bluesky's ProfileCard and
 * the Oxy inbox's `MailboxDrawer` footer. Pressing it opens the unified
 * {@link OxyAccountDialogScreen} — the single account switcher + sign-in surface — via
 * `useOxy().openAccountDialog`.
 *
 * Three auth states from {@link useAuth}:
 *  - **Undetermined** (`!isAuthResolved || isPrivateApiPending`): a neutral
 *    avatar-sized skeleton circle, no press.
 *  - **Signed in**: a pressable row — Bloom `Avatar` + display name + `@handle`
 *    + a chevron. Press opens the dialog on its `accounts` view.
 *  - **Signed out**: a "Sign in" row that calls `useAuth().signIn()` (which opens
 *    the dialog on its `signin` view).
 *
 * Styling uses react-native `StyleSheet` + the Bloom theme (via `useTheme`) so
 * the layout renders identically in EVERY consumer — including apps that do not
 * use NativeWind (e.g. the accounts app). Only the web hover animation keeps
 * dynamic inline `style` (the CSS transition/transform values), which is what
 * the `react-native-web-style.d.ts` augmentation exists for.
 */
const ProfileButton: React.FC<ProfileButtonProps> = ({
    expanded = true,
    avatarSize,
    onNavigateManage,
    onAddAccount,
    onNavigateProfile,
    className,
    style,
}) => {
    const {
        user,
        isAuthenticated,
        isAuthResolved,
        isPrivateApiPending,
        signIn,
    } = useAuth();
    const { openAccountDialog, oxyServices } = useOxy();
    const { colors } = useTheme();
    const { t, locale } = useI18n();

    // Web-only hover/focus tracking for the Bluesky-style reveal animation.
    // Native has no hover, so these stay false and the row renders statically.
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);

    const resolvedAvatarSize = avatarSize ?? (expanded ? 40 : 32);

    const openDialog = useCallback(() => {
        openAccountDialog('accounts');
    }, [openAccountDialog]);

    useEffect(() => {
        if (!onNavigateManage && !onAddAccount && !onNavigateProfile) {
            return undefined;
        }
        return registerAccountDialogConsumerHooks({
            onNavigateManage,
            onAddAccount,
            onNavigateProfile,
        });
    }, [onNavigateManage, onAddAccount, onNavigateProfile]);

    const avatarUrl = useMemo(
        () => (user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar, 'thumb') : undefined),
        [user?.avatar, oxyServices],
    );

    // ── Undetermined: skeleton circle, no interaction. ──────────────────────
    if (!isAuthResolved || isPrivateApiPending) {
        return (
            <View
                className={className}
                style={style}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            >
                <Skeleton.Circle size={resolvedAvatarSize} />
            </View>
        );
    }

    // ── Signed out: "Sign in" row. ──────────────────────────────────────────
    if (!isAuthenticated || !user) {
        const signInLabel = t('common.actions.signIn') || 'Sign in';
        return (
            <Pressable
                className={className}
                style={[styles.row, expanded && styles.rowExpanded, style]}
                onPress={() => { void signIn(); }}
                accessibilityRole="button"
                accessibilityLabel={signInLabel}
            >
                <View
                    style={[
                        styles.avatarBadge,
                        {
                            width: resolvedAvatarSize,
                            height: resolvedAvatarSize,
                            backgroundColor: colors.backgroundSecondary,
                        },
                    ]}
                >
                    <MaterialCommunityIcons
                        name="login"
                        size={Math.round(resolvedAvatarSize * 0.5)}
                        color={colors.icon}
                    />
                </View>
                {expanded ? (
                    <Text
                        style={[styles.signInLabel, { color: colors.text }]}
                        numberOfLines={1}
                    >
                        {signInLabel}
                    </Text>
                ) : null}
            </Pressable>
        );
    }

    // ── Signed in: avatar + identity + chevron. ─────────────────────────────
    const displayName = getAccountDisplayName(user, locale);
    const handle = getAccountFallbackHandle(user);
    const handleLine = handle ? `@${handle}` : null;

    const avatarNode = (
        <Avatar
            source={avatarUrl}
            variant="thumb"
            name={displayName}
            size={resolvedAvatarSize}
        />
    );

    // `active` combines hover and keyboard focus — exactly like Bluesky's
    // `state.hovered || state.focused`. Only web ever sets these, so on native
    // the row renders statically.
    const active = hovered || focused;
    const accountLabel = t('accountSwitcher.switchWhileSignedInAs', { name: displayName });

    // Web-only pointer/focus handlers. RN-Web forwards `onHoverIn`/`onHoverOut`
    // to the underlying element; native Pressable ignores them harmlessly, but
    // we only attach them on web to keep the native path pristine.
    const webInteractionProps = isWeb
        ? {
            onHoverIn: () => setHovered(true),
            onHoverOut: () => setHovered(false),
            onFocus: () => setFocused(true),
            onBlur: () => setFocused(false),
        }
        : undefined;

    if (!expanded) {
        // Collapsed: avatar-only. On web, hovering just fades a subtle round
        // background behind the avatar — no shrink, no text.
        const collapsedBgStyle: ViewStyle | undefined = isWeb
            ? {
                backgroundColor: active ? colors.backgroundSecondary : 'transparent',
                transitionProperty: 'background-color',
                transitionDuration: `${BG_TRANSITION_MS}ms`,
                transitionDelay: active ? '0ms' : `${LEAVE_DELAY_MS}ms`,
            }
            : undefined;
        return (
            <View className={className} style={style}>
                <Pressable
                    style={[styles.collapsedTrigger, collapsedBgStyle]}
                    onPress={openDialog}
                    accessibilityRole="button"
                    accessibilityLabel={accountLabel}
                    {...webInteractionProps}
                >
                    {avatarNode}
                </Pressable>
            </View>
        );
    }

    // ── Expanded row animation ──────────────────────────────────────────────
    // On native everything is statically visible (no hover exists). On web we
    // reproduce Bluesky's reveal: the row fills with a subtle contrast bg, the
    // avatar shrinks + slides left, and the name/handle/chevron fade in. The
    // negative left margin tucks the identity block under the shrunk avatar so
    // it slides out from behind it as the avatar contracts.
    const reducedMotion = isWeb && prefersReducedMotion();

    // Slide the shrunk avatar left so its visual left edge stays put as it
    // contracts. The avatar loses `size * (1 - scale)` of width; half of that
    // (the left half, since scale is centered) is the offset, plus the row's
    // left padding (8px) so it hugs the row edge like Bluesky's.
    const activeAvatarTranslateX =
        -(resolvedAvatarSize * (1 - ACTIVE_AVATAR_SCALE)) / 2 - 8;

    const rowStyle: StyleProp<ViewStyle> = isWeb
        ? {
            backgroundColor: active ? colors.backgroundSecondary : 'transparent',
            transitionProperty: 'background-color',
            transitionDuration: `${BG_TRANSITION_MS}ms`,
            transitionDelay: active ? '0ms' : `${LEAVE_DELAY_MS}ms`,
        }
        : undefined;

    const avatarWrapperStyle: ViewStyle | undefined = isWeb
        ? {
            zIndex: 10,
            ...(reducedMotion
                ? {}
                : {
                    transitionProperty: 'transform',
                    transitionDuration: `${AVATAR_TRANSITION_MS}ms`,
                    transitionDelay: active ? '0ms' : `${LEAVE_DELAY_MS}ms`,
                }),
            transform: active
                ? [{ scale: ACTIVE_AVATAR_SCALE }, { translateX: activeAvatarTranslateX }]
                : [{ scale: 1 }, { translateX: 0 }],
        }
        : undefined;

    const identityStyle: ViewStyle | undefined = isWeb
        ? {
            marginLeft: -resolvedAvatarSize / 2,
            opacity: active ? 1 : 0,
            transitionProperty: 'opacity',
            transitionDuration: `${OPACITY_TRANSITION_MS}ms`,
            transitionDelay: active ? '0ms' : `${LEAVE_DELAY_MS}ms`,
        }
        : undefined;

    const chevronStyle: ViewStyle | undefined = isWeb
        ? {
            opacity: active ? 1 : 0,
            transitionProperty: 'opacity',
            transitionDuration: `${OPACITY_TRANSITION_MS}ms`,
            transitionDelay: active ? '0ms' : `${LEAVE_DELAY_MS}ms`,
        }
        : undefined;

    return (
        <View className={className} style={[styles.fullWidth, style]}>
            <Pressable
                style={[styles.row, styles.rowExpanded, rowStyle]}
                onPress={openDialog}
                accessibilityRole="button"
                accessibilityLabel={accountLabel}
                {...webInteractionProps}
            >
                <View style={avatarWrapperStyle}>{avatarNode}</View>
                <View style={[styles.identity, identityStyle]}>
                    <Text
                        style={[styles.displayName, { color: colors.text }]}
                        numberOfLines={1}
                    >
                        {displayName}
                    </Text>
                    {handleLine ? (
                        <Text
                            style={[styles.handle, { color: colors.textSecondary }]}
                            numberOfLines={1}
                        >
                            {handleLine}
                        </Text>
                    ) : null}
                </View>
                <View style={chevronStyle}>
                    <MaterialCommunityIcons
                        name="dots-horizontal"
                        size={18}
                        color={colors.textSecondary}
                    />
                </View>
            </Pressable>
        </View>
    );
};

const styles = StyleSheet.create({
    fullWidth: {
        width: '100%',
    },
    // Shared trigger row (`flex-row items-center gap-3 rounded-full px-2 py-2`).
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderRadius: 9999,
        paddingHorizontal: 8,
        paddingVertical: 8,
    },
    // `w-full` on the expanded row + its signed-out variant.
    rowExpanded: {
        width: '100%',
    },
    // Signed-out login badge (`items-center justify-center rounded-full`).
    avatarBadge: {
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 9999,
    },
    // Signed-out label (`flex-1 font-semibold`).
    signInLabel: {
        flex: 1,
        fontWeight: '600',
    },
    // Collapsed avatar-only trigger (`rounded-full`).
    collapsedTrigger: {
        borderRadius: 9999,
    },
    // Identity block (`min-w-0 flex-1`).
    identity: {
        flex: 1,
        minWidth: 0,
    },
    // Display name (`font-bold`).
    displayName: {
        fontWeight: '700',
    },
    // Handle line (`text-xs`).
    handle: {
        fontSize: 12,
    },
});

export default ProfileButton;
