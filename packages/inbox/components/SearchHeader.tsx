/**
 * Reusable Gmail-style search header bar.
 *
 * Centered with max width, used on both inbox (as a button) and search (as an
 * input). In placeholder (button) mode the leading icon and the pill use
 * side-by-side Pressables — never nested TouchableOpacity — so the leading
 * button's tap doesn't bubble up to the pill's onPress.
 */

import React, { forwardRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { Menu01Icon, ArrowLeft01Icon, Cancel01Icon } from '@hugeicons/core-free-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LinearGradient } from 'expo-linear-gradient';

import { useColors } from '@/constants/theme';
import { CONTENT_MAX_WIDTH } from '@/constants/layout';
import { fadeOut } from '@/utils/fadeOut';
import { useTranslation } from '@/lib/i18n';

const HUGE_ICON_MAP: Record<string, IconSvgElement> = {
  menu: Menu01Icon as unknown as IconSvgElement,
  'arrow-left': ArrowLeft01Icon as unknown as IconSvgElement,
};

const ICON_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

interface SearchHeaderProps {
  /** Left icon action (e.g. open drawer, go back) */
  onLeftIcon: () => void;
  /** Left icon name */
  leftIcon?: keyof typeof MaterialCommunityIcons.glyphMap;
  /** If provided, renders as a tappable placeholder instead of an input */
  placeholder?: string;
  /** Tap handler when in placeholder mode */
  onPress?: () => void;
  /** Input value (active search mode) */
  value?: string;
  /** Input change handler (active search mode) */
  onChangeText?: (text: string) => void;
  /** Submit handler (active search mode) */
  onSubmitEditing?: () => void;
  /** Clear button handler */
  onClear?: () => void;
  /** Auto focus the input */
  autoFocus?: boolean;
}

export const SearchHeader = forwardRef<TextInput, SearchHeaderProps>(function SearchHeader(
  {
    onLeftIcon,
    leftIcon = 'menu',
    placeholder,
    onPress,
    value,
    onChangeText,
    onSubmitEditing,
    onClear,
    autoFocus,
  },
  ref,
) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { t } = useTranslation();

  const isInputMode = onChangeText !== undefined;
  const leftIconLabel = leftIcon === 'menu' ? t('search.openMenu') : t('search.goBack');
  // Default the search-pill placeholder to the localized `search.placeholder`.
  // Callers can still pass a custom value (e.g. "Search in inbox") which is
  // already localized at the call site.
  const resolvedPlaceholder = placeholder ?? t('search.placeholder');

  const renderLeftIcon = () => (
    Platform.OS === 'web' && HUGE_ICON_MAP[leftIcon] ? (
      <HugeiconsIcon icon={HUGE_ICON_MAP[leftIcon]} size={24} color={colors.icon} />
    ) : (
      <MaterialCommunityIcons name={leftIcon} size={24} color={colors.icon} />
    )
  );

  // Opaque at the top, fading out at the bottom, so content scrolling
  // underneath dissolves into the header instead of meeting a hard edge.
  // Built from `colors.background` so the ramp stays theme-aware.
  return (
    <LinearGradient
      colors={[colors.background, fadeOut(colors.background)]}
      style={[
        styles.wrapper,
        {
          paddingTop: insets.top + 8,
          paddingLeft: 8 + insets.left,
          paddingRight: 8 + insets.right,
        },
      ]}
    >
      <View style={styles.bar}>
        {isInputMode ? (
          <>
            <Pressable
              accessibilityLabel={leftIconLabel}
              accessibilityRole="button"
              onPress={onLeftIcon}
              style={styles.iconButton}
              hitSlop={ICON_HIT_SLOP}
            >
              {renderLeftIcon()}
            </Pressable>
            <TextInput
              ref={ref}
              style={[styles.input, { color: colors.searchText, backgroundColor: colors.searchBackground }]}
              value={value}
              onChangeText={onChangeText}
              placeholder={resolvedPlaceholder}
              placeholderTextColor={colors.searchPlaceholder}
              returnKeyType="search"
              onSubmitEditing={onSubmitEditing}
              autoFocus={autoFocus}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {value && value.length > 0 && onClear && (
              <Pressable
                accessibilityLabel={t('search.clear')}
                accessibilityRole="button"
                onPress={onClear}
                style={styles.iconButton}
                hitSlop={ICON_HIT_SLOP}
              >
                {Platform.OS === 'web' ? (
                  <HugeiconsIcon icon={Cancel01Icon as unknown as IconSvgElement} size={20} color={colors.icon} />
                ) : (
                  <MaterialCommunityIcons name="close" size={20} color={colors.icon} />
                )}
              </Pressable>
            )}
          </>
        ) : (
          /*
           * Side-by-side Pressables (Gmail pattern): a full-width pill that
           * opens search, plus an absolutely positioned leading icon button
           * on top of the pill that opens the drawer / goes back. They no
           * longer nest, so taps on the leading icon don't bubble.
           */
          <View style={styles.placeholderRow}>
            <Pressable
              accessibilityLabel={resolvedPlaceholder}
              accessibilityRole="search"
              style={({ pressed }) => [
                styles.pillButton,
                { backgroundColor: colors.searchBackground },
                pressed && styles.pillButtonPressed,
              ]}
              onPress={onPress}
            >
              <Text
                style={[
                  styles.placeholderText,
                  styles.placeholderTextWithLeftSpace,
                  { color: colors.searchPlaceholder },
                ]}
                numberOfLines={1}
              >
                {resolvedPlaceholder}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel={leftIconLabel}
              accessibilityRole="button"
              onPress={onLeftIcon}
              style={styles.leadingIconOverlay}
              hitSlop={ICON_HIT_SLOP}
            >
              {renderLeftIcon()}
            </Pressable>
          </View>
        )}
      </View>
    </LinearGradient>
  );
});

const styles = StyleSheet.create({
  // `paddingLeft` / `paddingRight` are applied inline so they can include
  // landscape `insets.left` / `insets.right`.
  wrapper: {
    alignItems: 'center',
    paddingBottom: 8,
  },
  bar: {
    // Same column as the list below it, so the search field and the rows share
    // a left edge. The gradient behind it stays full-bleed.
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  input: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    paddingHorizontal: 16,
    fontSize: 16,
  },
  placeholderRow: {
    flex: 1,
    position: 'relative',
    justifyContent: 'center',
  },
  pillButton: {
    width: '100%',
    height: 48,
    borderRadius: 28,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  pillButtonPressed: {
    opacity: 0.8,
  },
  leadingIconOverlay: {
    position: 'absolute',
    left: 4,
    top: 2,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  placeholderText: {
    fontSize: 16,
  },
  placeholderTextWithLeftSpace: {
    // Reserve room for the 44pt overlay icon + ~4pt padding so the
    // placeholder text isn't covered by the leading button.
    paddingLeft: 44,
  },
});
