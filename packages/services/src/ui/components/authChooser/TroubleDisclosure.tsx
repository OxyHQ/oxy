/**
 * The "Having trouble?" progressive disclosure (issue #691, Phase 5).
 *
 * The normal sign-in surface presents ONE primary action. Every alternative —
 * scanning a QR from another device, a passkey on this device, getting Commons,
 * creating an account — lives here, hidden until the user asks for it or the
 * chosen primary route fails.
 *
 * Two renderings, deliberately not one controlled component:
 *  - `revealed` (the primary route failed, or there IS no primary route): the
 *    alternatives ARE the surface's content now, so they render plainly. There
 *    is nothing left to hide them behind.
 *  - otherwise: Bloom's own `Collapsible`, whose trigger is the small
 *    "Having trouble?" affordance.
 *
 * Splitting on `revealed` is what keeps the open state where it belongs — inside
 * Bloom's uncontrolled disclosure — instead of forcing a hand-rolled controlled
 * copy of it here.
 */

import type React from 'react';
import { View } from 'react-native';
import { Collapsible } from '@oxyhq/bloom/collapsible';
import { SubtleLink } from './primitives';
import { authChooserStyles as styles } from './styles';
import type { OxySignInSurfaceAction, Theme, Translate } from './types';

interface TroubleDisclosureProps {
  /** The alternative routes out of the current surface. Always subordinate links. */
  actions: readonly OxySignInSurfaceAction[];
  /**
   * `true` when the primary route could not be carried out (`signIn.routeFailed`)
   * or the surface has no working primary at all (a failed request). The
   * alternatives are shown without asking.
   */
  revealed: boolean;
  theme: Theme;
  t: Translate;
}

const TroubleDisclosure: React.FC<TroubleDisclosureProps> = ({ actions, revealed, theme, t }) => {
  if (actions.length === 0) return null;

  const links = (
    <View style={styles.troubleActions}>
      {actions.map((action) => (
        <SubtleLink
          key={action.key}
          label={action.label}
          theme={theme}
          onPress={action.onPress}
          disabled={action.disabled}
          testID={action.key}
        />
      ))}
    </View>
  );

  if (revealed) return links;

  return (
    <Collapsible
      title={t('accountSwitcher.havingTrouble')}
      style={styles.troubleTrigger}
      titleStyle={[styles.linkText, { color: theme.colors.textSecondary }]}
      testID="trouble-disclosure"
    >
      {links}
    </Collapsible>
  );
};

export default TroubleDisclosure;
