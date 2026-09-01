/**
 * Shared shell for every settings subscreen.
 *
 * Provides:
 *  - Mobile: a top header with back chevron + title (no native large title —
 *    we keep the chrome consistent across iOS/Android/web).
 *  - Desktop: a slim header with the section title (back chevron hidden,
 *    since the sidebar is permanent and the breadcrumb is implicit).
 *  - Safe-area-aware vertical and landscape horizontal padding.
 *  - A `ScrollView` body with a max-width content rail on web and proper
 *    bottom inset so floating elements don't overlap the last row.
 *
 * Children are rendered inside the scroll view. Pass `scrollable={false}`
 * to opt out (e.g. for a screen that needs a fixed-height layout).
 */

import React from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { H3, Text } from '@oxyhq/bloom/typography';
import { IconButton } from '@oxyhq/bloom/button';
import { ChevronLeft_Stroke2_Corner0_Rounded } from '@oxyhq/bloom/icons';

import { useGoBack } from '@/hooks/useGoBack';
import { useColors } from '@/constants/theme';

interface SettingsScreenShellProps {
  title: string;
  /** Optional supplemental description shown under the header title. */
  subtitle?: string;
  /** Right-aligned header accessory (e.g. Save button). */
  headerRight?: React.ReactNode;
  /** Whether to render content inside a ScrollView (default true). */
  scrollable?: boolean;
  children: React.ReactNode;
}

const DESKTOP_BREAKPOINT = 900;

export function SettingsScreenShell({
  title,
  subtitle,
  headerRight,
  scrollable = true,
  children,
}: SettingsScreenShellProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const colors = useColors();
  const isDesktop = Platform.OS === 'web' && width >= DESKTOP_BREAKPOINT;

  // On desktop the sidebar is permanent and provides the back affordance, so
  // we hide the back chevron there. On mobile we always show it for browsers
  // and native alike.
  const showBack = !isDesktop;

  const handleBack = useGoBack('/settings');

  const headerTopPad = isDesktop ? 0 : insets.top;
  const contentBottomPad = insets.bottom + 32;
  const horizontalLandscapePad = Math.max(insets.left, insets.right);

  const body = (
    <View style={[styles.bodyContainer, { paddingHorizontal: horizontalLandscapePad }]}>
      {children}
    </View>
  );

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: colors.background, paddingTop: headerTopPad },
      ]}
    >
      <View
        style={[
          styles.header,
          { borderBottomColor: colors.border, paddingHorizontal: horizontalLandscapePad + 4 },
        ]}
      >
        {showBack ? (
          <IconButton
            onPress={handleBack}
            size="small"
            accessibilityLabel="Back"
            icon={<ChevronLeft_Stroke2_Corner0_Rounded size="md" style={{ color: colors.icon }} />}
          />
        ) : (
          <View style={styles.headerSpacerLeft} />
        )}

        <View style={styles.headerTitleWrap}>
          <H3 style={styles.headerTitle} numberOfLines={1}>{title}</H3>
          {subtitle ? (
            <Text style={[styles.headerSubtitle, { color: colors.secondaryText }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View style={styles.headerRight}>{headerRight}</View>
      </View>

      {scrollable ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{ paddingBottom: contentBottomPad, paddingTop: 16 }}
          showsVerticalScrollIndicator={false}
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
    minHeight: 56,
  },
  headerSpacerLeft: {
    width: 12,
  },
  headerTitleWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 22,
    lineHeight: 28,
  },
  headerSubtitle: {
    fontSize: 13,
    marginTop: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 8,
  },
  scroll: {
    flex: 1,
  },
  bodyContainer: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    gap: 4,
  },
});
