/**
 * The small presentational building blocks shared across the auth chooser's
 * views. One responsibility each, no controller access, no side effects — they
 * take props and render.
 */

import type React from 'react';
import { Pressable } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { authChooserStyles as styles } from './styles';
import type { Theme } from './types';

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
