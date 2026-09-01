/**
 * The small presentational building blocks shared across the auth chooser's
 * views. One responsibility each, no controller access, no side effects — they
 * take props and render.
 */

import type React from 'react';
import { useState } from 'react';
import { Pressable, View } from 'react-native-css/components';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Text } from '@oxyhq/bloom/typography';
import { BloomColorScope } from '@oxyhq/bloom/theme';
import type { SwitchableAccount } from '@oxyhq/core';
import { authChooserStyles as styles } from './styles';
import { resolveAccentHex, toPreset, type Theme } from './types';

/** Diameter of a row avatar (the sign-in view's account rows). */
const ROW_AVATAR_SIZE = 40;

type HoverPressableProps = Omit<React.ComponentProps<typeof Pressable>, 'className'> & {
  baseClassName: string;
  hoverClassName: string;
};

/**
 * A `Pressable` that appends a hover-tint NativeWind token while pointer-hovered.
 * The Metro web pipeline here does NOT emit NativeWind `hover:` variants, so hover
 * is driven by RN's cross-platform `onHoverIn`/`onHoverOut` (they fire only on web
 * via react-native-web; a no-op on native) toggling a plain background token —
 * the tint stays a NativeWind class, only the trigger is JS.
 */
export const HoverPressable: React.FC<HoverPressableProps> = ({
  baseClassName,
  hoverClassName,
  ...rest
}) => {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      {...rest}
      className={hovered ? `${baseClassName} ${hoverClassName}` : baseClassName}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
    />
  );
};

/**
 * A SUBORDINATE action: a small centred text link, never a button.
 *
 * This is the single visual grammar for everything that is not the surface's one
 * primary action (issue #691) — the sign-up entry, and every alternative revealed
 * behind "Having trouble?". Keeping them all on one component is what stops an
 * alternative from quietly growing into a co-equal button again.
 */
export const SubtleLink: React.FC<{
  label: string;
  theme: Theme;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}> = ({ label, theme, onPress, disabled, testID }) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="button"
    accessibilityLabel={label}
    style={styles.footerLink}
    testID={testID}
  >
    <Text style={[styles.linkText, { color: theme.colors.textSecondary }]}>{label}</Text>
  </Pressable>
);

/** A labelled hairline separating two blocks ("or"). */
export const Dividerish: React.FC<{ theme: Theme; label: string }> = ({ theme, label }) => (
  <View style={styles.dividerRow}>
    <View style={[styles.dividerLine, { backgroundColor: theme.colors.border }]} />
    <Text style={[styles.dividerText, { color: theme.colors.textSecondary }]}>{label}</Text>
    <View style={[styles.dividerLine, { backgroundColor: theme.colors.border }]} />
  </View>
);

/**
 * An account row on the sign-in entry — "continue as one of these" rather than a
 * choice of authentication METHOD, which is why it stays above the primary CTA
 * instead of behind the trouble disclosure.
 */
export const AccountRow: React.FC<{
  account: SwitchableAccount;
  theme: Theme;
  switching: boolean;
  disabled: boolean;
  onPress: () => void;
}> = ({ account, theme, switching, disabled, onPress }) => {
  const accent = resolveAccentHex(account.color, theme.colors.primary);

  return (
    <BloomColorScope colorPreset={toPreset(account.color)} asChild>
      <Pressable
        style={[
          styles.accountRow,
          {
            borderColor: account.isCurrent ? accent : theme.colors.border,
            backgroundColor: theme.colors.card,
          },
          disabled && !switching ? styles.rowDisabled : null,
        ]}
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ selected: account.isCurrent, disabled }}
        accessibilityLabel={account.displayName}
      >
        <View style={[styles.avatarRing, { borderColor: account.isCurrent ? accent : 'transparent' }]}>
          <Avatar
            source={account.avatarUrl ?? undefined}
            variant="thumb"
            name={account.displayName}
            size={ROW_AVATAR_SIZE}
          />
        </View>
        <View style={styles.rowMeta}>
          <Text style={[styles.rowName, { color: theme.colors.text }]} numberOfLines={1}>
            {account.displayName}
          </Text>
          {account.email ? (
            <Text style={[styles.rowHandle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
              {account.email}
            </Text>
          ) : null}
        </View>
        {switching ? (
          <MaterialCommunityIcons name="loading" size={20} color={accent} />
        ) : account.isCurrent ? (
          <MaterialCommunityIcons name="check-circle" size={20} color={accent} />
        ) : (
          <MaterialCommunityIcons name="chevron-right" size={20} color={theme.colors.textSecondary} />
        )}
      </Pressable>
    </BloomColorScope>
  );
};
