import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, { Easing, withTiming } from 'react-native-reanimated';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { darkenColor } from '@/utils/color-utils';
import { useTranslation } from '@/lib/i18n';
import { floatingPosition } from '@/constants/styles';
import { QuickActionButton } from './quick-action-button';

const ICON_ANIM_MS = 350;
const ICON_EASING = Easing.bezier(0.34, 1.56, 0.64, 1);

/** Custom entering animation: rotate(-90°→0°) + scale(0.4→1) + fade in. */
const themeIconEntering = () => {
  'worklet';
  const config = { duration: ICON_ANIM_MS, easing: ICON_EASING };
  return {
    initialValues: {
      opacity: 0,
      transform: [{ rotate: '-90deg' }, { scale: 0.4 }],
    },
    animations: {
      opacity: withTiming(1, config),
      transform: [
        { rotate: withTiming('0deg', config) },
        { scale: withTiming(1, config) },
      ],
    },
  };
};

interface BottomActionBarProps {
  variant: 'desktop' | 'mobile';
  mode: 'light' | 'dark';
  onReload: () => void;
  onDevices: () => void;
  onToggleTheme: () => void;
  onScanQR: () => void;
}

/**
 * Floating quick-action cluster rendered at the bottom-right of the tabs
 * layout. Replaces the two near-identical action-button rows that were
 * inlined in the desktop and mobile branches of `(tabs)/_layout`.
 *
 * - `desktop` shows scan-QR (native only), reload, devices and theme toggle,
 *   with the theme glyph animating on each mode change.
 * - `mobile` shows reload, devices and theme toggle (scan-QR lives in the FAB).
 */
export function BottomActionBar({
  variant,
  mode,
  onReload,
  onDevices,
  onToggleTheme,
  onScanQR,
}: BottomActionBarProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const isDesktop = variant === 'desktop';

  const themeIconNode = isDesktop ? (
    <Animated.View key={mode} entering={themeIconEntering}>
      <MaterialCommunityIcons
        name={mode === 'dark' ? 'weather-sunny' : 'weather-night'}
        size={22}
        color={darkenColor(colors.sidebarIconData)}
      />
    </Animated.View>
  ) : undefined;

  return (
    <View style={[isDesktop ? styles.desktopBottomActions : styles.mobileBottomActions, floatingPosition]}>
      {isDesktop && Platform.OS !== 'web' && (
        <QuickActionButton
          icon="qrcode-scan"
          backgroundColor={colors.sidebarIconSecurity}
          onPress={onScanQR}
          accessibilityLabel={t('a11y.scanQr')}
        />
      )}
      <QuickActionButton
        icon="reload"
        backgroundColor={colors.sidebarIconSecurity}
        onPress={onReload}
        accessibilityLabel={t('a11y.refresh')}
      />
      <QuickActionButton
        icon="desktop-classic"
        backgroundColor={colors.sidebarIconDevices}
        onPress={onDevices}
        accessibilityLabel={t('drawer.devices')}
      />
      <QuickActionButton
        icon={mode === 'dark' ? 'weather-sunny' : 'weather-night'}
        backgroundColor={colors.sidebarIconData}
        onPress={onToggleTheme}
        accessibilityLabel={t('a11y.themeToggle')}
        iconNode={themeIconNode}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  desktopBottomActions: {
    bottom: 24,
    right: 24,
    flexDirection: 'row',
    gap: 16,
    zIndex: 1000,
  },
  mobileBottomActions: {
    bottom: 24,
    right: 24,
    flexDirection: 'row',
    gap: 12,
    zIndex: 1000,
  },
});
