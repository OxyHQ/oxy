/**
 * The small presentational building blocks shared across the auth chooser's
 * views. One responsibility each, no controller access, no side effects — they
 * take props and render.
 */

import type React from 'react';
import { LinkButton } from '@oxy.so/bloom/button';
import { authChooserStyles as styles } from './styles';

/**
 * A SUBORDINATE action: a small centred text link, never a button.
 *
 * This is the single visual grammar for everything that is not the surface's one
 * primary action (issue #691) — the sign-up entry, and every alternative revealed
 * behind "Having trouble?". Keeping them all on one component is what stops an
 * alternative from quietly growing into a co-equal button again.
 *
 * Bloom's `LinkButton` in the secondary tone at `sm`: no fill or border, the
 * secondary text colour, underlined under a pointer, and Bloom's link hit slop
 * for the touch target. The vertical padding keeps the stack's old rhythm.
 */
export const SubtleLink: React.FC<{
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}> = ({ label, onPress, disabled, testID }) => (
  <LinkButton
    variant="secondary"
    size="sm"
    onPress={onPress}
    disabled={disabled}
    accessibilityLabel={label}
    style={styles.footerLink}
    testID={testID}
  >
    {label}
  </LinkButton>
);
