import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { useRouter, usePathname, type Href } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useTheme } from '@oxyhq/bloom/theme';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { darkenColor } from '@/utils/color-utils';
import { useHapticPress } from '@/hooks/use-haptic-press';
import type { MaterialCommunityIconName } from '@/types/icons';
import { useTranslation } from '@/lib/i18n';
import { ProfileButton } from '@oxyhq/services';

// Narrow to the string variant of Href so menu items can be used as React
// keys and compared to `pathname` strings without casting.
type MenuPath = Extract<Href, string>;

export interface MenuItem {
    path: MenuPath;
    icon: MaterialCommunityIconName;
    /** Translation key under `drawer.*`. */
    labelKey: string;
    iconColor: string;
}

export const menuItems: MenuItem[] = [
    { path: '/(tabs)', icon: 'home-variant', labelKey: 'drawer.home', iconColor: 'sidebarIconHome' },
    { path: '/(tabs)/personal-info', icon: 'card-account-details-outline', labelKey: 'drawer.personalInfo', iconColor: 'sidebarIconPersonalInfo' },
    { path: '/(tabs)/security', icon: 'lock-outline', labelKey: 'drawer.security', iconColor: 'sidebarIconSecurity' },
    { path: '/(tabs)/activity', icon: 'pulse', labelKey: 'drawer.activity', iconColor: 'sidebarIconActivity' },
    { path: '/(tabs)/devices', icon: 'desktop-classic', labelKey: 'drawer.devices', iconColor: 'sidebarIconDevices' },
    { path: '/(tabs)/data', icon: 'toggle-switch-outline', labelKey: 'drawer.data', iconColor: 'sidebarIconData' },
    { path: '/(tabs)/sharing', icon: 'account-group-outline', labelKey: 'drawer.sharing', iconColor: 'sidebarIconSharing' },
    { path: '/(tabs)/managed-accounts', icon: 'account-supervisor-outline', labelKey: 'drawer.yourIdentities', iconColor: 'sidebarIconSharing' },
    { path: '/(tabs)/family', icon: 'share-variant-outline', labelKey: 'drawer.thirdParty', iconColor: 'sidebarIconFamily' },
    { path: '/(tabs)/payments', icon: 'wallet-outline', labelKey: 'drawer.payments', iconColor: 'sidebarIconPayments' },
    { path: '/(tabs)/storage', icon: 'cloud-outline', labelKey: 'drawer.storage', iconColor: 'sidebarIconStorage' },
];

interface SidebarContentProps {
    onNavigate?: () => void;
}

export function SidebarContent({ onNavigate }: SidebarContentProps) {
    const colors = useColors();
    const { mode } = useTheme();
    const router = useRouter();
    const pathname = usePathname();
    const { t } = useTranslation();

    const handlePressIn = useHapticPress();

    const handleNavigate = (path: MenuPath) => {
        router.push(path);
        onNavigate?.();
    };

    return (
        <>
            <View style={styles.profileContainer}>
                <ProfileButton
                    placement="down"
                    onNavigateManage={() => {
                        router.push('/(tabs)');
                        onNavigate?.();
                    }}
                    onAddAccount={() => {
                        router.push('/(auth)');
                        onNavigate?.();
                    }}
                />
            </View>
            <View style={styles.menuContainer}>
                {menuItems.map((item) => {
                    const isActive = pathname === item.path || (item.path === '/(tabs)' && (pathname === '/(tabs)' || pathname === '/(tabs)/'));
                    const iconColor = colors[item.iconColor as keyof typeof colors] as string;

                    const menuItemContent = (
                        <>
                            <View style={[styles.menuIconContainer, { backgroundColor: iconColor }]}>
                                <MaterialCommunityIcons name={item.icon} size={22} color={darkenColor(iconColor)} />
                            </View>
                            <Text style={[styles.menuItemText, { color: isActive ? colors.sidebarItemActiveText : colors.text }]}>
                                {t(item.labelKey)}
                            </Text>
                        </>
                    );

                    return (
                        <TouchableOpacity
                            key={item.path}
                            onPressIn={handlePressIn}
                            onPress={() => handleNavigate(item.path)}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            accessibilityLabel={t(item.labelKey)}
                            accessibilityState={{ selected: isActive }}
                        >
                            <BlurView
                                intensity={isActive ? 80 : 50}
                                tint={mode === 'dark' ? 'dark' : 'light'}
                                style={[
                                    styles.menuItem,
                                    isActive ? styles.menuItemActive : null,
                                    { backgroundColor: isActive ? colors.sidebarItemActiveBackground : 'rgba(255, 255, 255, 0.1)' }
                                ]}
                            >
                                {menuItemContent}
                            </BlurView>
                        </TouchableOpacity>
                    );
                })}
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    profileContainer: {
        marginBottom: 12,
        alignSelf: 'stretch',
    },
    menuContainer: {
        gap: 4,
        alignItems: 'flex-start',
    },
    menuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingLeft: 12,
        paddingRight: 24,
        borderRadius: 26,
        gap: 12,
        overflow: 'hidden',
        alignSelf: 'flex-start',
    },
    menuItemActive: {},
    menuIconContainer: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    menuItemText: {
        fontSize: 14,
        fontWeight: '400',
    },
});
