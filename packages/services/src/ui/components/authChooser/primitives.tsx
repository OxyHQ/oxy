/**
 * The small presentational building blocks shared across the auth chooser's
 * views. One responsibility each, no controller access, no side effects — they
 * take props and render.
 */

import type React from 'react';
import { Pressable, View } from 'react-native';
import MaterialCommunityIcons from '../../icons/MaterialCommunityIcons';
import { Avatar } from '@oxy.so/bloom/avatar';
import { BloomColorScope } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import type { SwitcherContextRow } from '@oxy.so/core';
import { authChooserStyles as styles } from './styles';
import { resolveAccentHex, toPreset, type Theme } from './types';

/** Diameter of a row avatar (the sign-in view's account rows). */
const ROW_AVATAR_SIZE = 40;

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

/**
 * A `principal acting as account` row on the sign-in entry — "continue as one of
 * these" rather than a choice of authentication METHOD, which is why it stays
 * above the primary CTA instead of behind the trouble disclosure.
 *
 * Pressing it activates the PAIR. The secondary line is the account's `@handle`:
 * the device directory carries a handle and no email, deliberately — it is the
 * minimum that renders a row for every person on the device, and this surface is
 * reached while signed out, where fetching anyone's profile is not an option.
 *
 * The accent comes from the row's OWN account (`context.color`, straight off the
 * directory), not from the theme and not from whoever is signed in. This surface
 * is where a device holding two people is most visible, and it is reached while
 * signed out — so there is no "current user" whose colour could stand in.
 *
 * `continueAsLabel` is the signed-out form. The device can list an identity
 * (and even mark it active) while this app holds no session, so a check there
 * would claim a sign-in that has not happened. Given a label, the row never
 * reads as current: its first line is "Continue as @handle", the account's
 * name moves to the second line, and it ends in a chevron like any other row.
 */
export const AccountRow: React.FC<{
  context: SwitcherContextRow;
  /** The person this account is reached through, when that is not obvious. */
  operatedBy: string | null;
  /** Signed out: the row's "Continue as @handle" line. `null` when signed in. */
  continueAsLabel?: string | null;
  theme: Theme;
  activating: boolean;
  disabled: boolean;
  onPress: () => void;
}> = ({ context, operatedBy, continueAsLabel = null, theme, activating, disabled, onPress }) => {
  const accent = resolveAccentHex(context.color, theme.colors.primary);
  const rowDisabled = disabled || !context.canActivate;
  const current = continueAsLabel === null && context.isActive;
  const primary = continueAsLabel ?? context.displayName;
  const secondary =
    operatedBy ??
    (continueAsLabel !== null ? context.displayName : context.handle ? `@${context.handle}` : null);

  return (
    <BloomColorScope colorPreset={toPreset(context.color)} asChild>
      <Pressable
        style={[
          styles.accountRow,
          {
            borderColor: current ? accent : theme.colors.border,
            backgroundColor: theme.colors.card,
          },
          rowDisabled && !activating ? styles.rowDisabled : null,
        ]}
        onPress={onPress}
        disabled={rowDisabled}
        accessibilityRole="button"
        accessibilityState={{ selected: current, disabled: rowDisabled }}
        accessibilityLabel={primary}
      >
        <View style={[styles.avatarRing, { borderColor: current ? accent : 'transparent' }]}>
          <Avatar
            source={context.avatarUrl ?? undefined}
            variant="thumb"
            name={context.displayName}
            size={ROW_AVATAR_SIZE}
          />
        </View>
        <View style={styles.rowMeta}>
          <Text style={[styles.rowName, { color: theme.colors.text }]} numberOfLines={1}>
            {primary}
          </Text>
          {secondary ? (
            <Text style={[styles.rowHandle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
              {secondary}
            </Text>
          ) : null}
        </View>
        {activating ? (
          <MaterialCommunityIcons name="loading" size={20} color={accent} />
        ) : current ? (
          <MaterialCommunityIcons name="check-circle" size={20} color={accent} />
        ) : (
          <MaterialCommunityIcons name="chevron-right" size={20} color={theme.colors.textSecondary} />
        )}
      </Pressable>
    </BloomColorScope>
  );
};
