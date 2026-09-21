import type React from 'react';
import { useCallback, useEffect, useMemo } from 'react';
import {
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { View } from 'react-native-css/components';
import * as Icons from '@oxy.so/bloom/icons';
import { Button } from '@oxy.so/bloom/button';
import { Avatar } from '@oxy.so/bloom/avatar';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { getAccountDisplayName, getAccountFallbackHandle, getNormalizedUserHandle } from '@oxy.so/core';
import { useAuth } from '../hooks/useAuth';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { registerAccountDialogConsumerHooks } from '../navigation/accountDialogManager';
import type { AccountDialogMenuItem } from '../navigation/accountDialogManager';

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
    /** App-owned actions rendered in the shared account menu. */
    menuItems?: readonly AccountDialogMenuItem[];
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

/** Account business binding over Bloom's shared Button and Avatar. */
const ProfileButton: React.FC<ProfileButtonProps> = ({
    expanded = true,
    avatarSize,
    onNavigateManage,
    onAddAccount,
    onNavigateProfile,
    menuItems,
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

    const resolvedAvatarSize = avatarSize ?? (expanded ? 40 : 32);

    const openDialog = useCallback(() => {
        openAccountDialog('accounts');
    }, [openAccountDialog]);

    useEffect(() => {
        if (!onNavigateManage && !onAddAccount && !onNavigateProfile && !menuItems?.length) {
            return undefined;
        }
        return registerAccountDialogConsumerHooks({
            onNavigateManage,
            onAddAccount,
            onNavigateProfile,
            menuItems,
        });
    }, [onNavigateManage, onAddAccount, onNavigateProfile, menuItems]);

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

    const signedIn = isAuthenticated && Boolean(user);
    const displayName = signedIn
        ? user?.name?.displayName ?? getNormalizedUserHandle(user) ?? getAccountDisplayName(null, locale)
        : t('common.actions.signIn') || 'Sign in';
    const handle = signedIn ? getAccountFallbackHandle(user) : undefined;
    const label = signedIn ? t('accountSwitcher.switchWhileSignedInAs', { name: displayName }) : displayName;

    return (
        <Button
            appearance="plain" tone="neutral"
            className={className}
            accessibilityLabel={label}
            onPress={signedIn ? openDialog : () => { void signIn(); }}
            style={[{ height: resolvedAvatarSize + 16, borderRadius: 9999, paddingLeft: 8, paddingRight: 8, ...(expanded ? { width: '100%' } : { width: resolvedAvatarSize + 16 }) }, style]}
            trailing={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, ...(expanded ? { flex: 1 } : {}) }}>
                    {signedIn ? <Avatar source={avatarUrl} variant="thumb" name={displayName} size={resolvedAvatarSize} />
                        : <Icons.RiLoginBoxLine width={resolvedAvatarSize / 2} height={resolvedAvatarSize / 2} color={colors.icon} />}
                    {expanded ? <>
                        <View style={{ flex: 1, minWidth: 0 }}>
                            <Text variant="body-semibold" numberOfLines={1}>{displayName}</Text>
                            {handle ? <Text variant="caption-1-regular" numberOfLines={1} style={{ color: colors.textSecondary }}>@{handle}</Text> : null}
                        </View>
                        {signedIn ? <Icons.RiMoreLine width={18} height={18} color={colors.textSecondary} /> : null}
                    </> : null}
                </View>
            }
        />
    );
};

export default ProfileButton;
