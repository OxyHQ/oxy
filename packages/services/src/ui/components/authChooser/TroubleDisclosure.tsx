/**
 * The "Having trouble?" progressive disclosure (issue #691, Phase 5).
 *
 * The normal sign-in surface presents ONE primary action. Every alternative —
 * scanning a QR from another device, a passkey on this device, getting Commons,
 * creating an account — lives here, hidden until the user asks for it or the
 * chosen primary route fails.
 *
 * Two renderings:
 *  - `revealed` (the primary route failed, or there IS no primary route): the
 *    alternatives ARE the surface's content now, so they render plainly. There
 *    is nothing left to hide them behind.
 *  - otherwise: a single-item Bloom `Accordion`, whose trigger is the small
 *    "Having trouble?" affordance.
 *
 * The disclosure is CONTROLLED because Bloom 1.0.0's `Accordion` — which
 * replaced the deleted `Collapsible` — takes `value`/`onValueChange` and has no
 * uncontrolled mode. Splitting on `revealed` still matters: it decides whether
 * a disclosure exists at all, so the open state below only ever describes the
 * collapsed rendering.
 */

import type React from 'react';
import { useState } from 'react';
import { View } from 'react-native';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@oxyhq/bloom/accordion';
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

/** The accordion's single item. Its identity is never shown to the user. */
const TROUBLE_ITEM = 'trouble';

const TroubleDisclosure: React.FC<TroubleDisclosureProps> = ({ actions, revealed, theme, t }) => {
  // Declared above the early return: hooks may not sit behind a conditional.
  const [openItem, setOpenItem] = useState<string | string[] | undefined>(undefined);

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
    <Accordion
      type="single"
      value={openItem}
      onValueChange={setOpenItem}
      style={styles.troubleTrigger}
      testID="trouble-disclosure"
    >
      <AccordionItem value={TROUBLE_ITEM}>
        <AccordionTrigger textStyle={[styles.linkText, { color: theme.colors.textSecondary }]}>
          {t('accountSwitcher.havingTrouble')}
        </AccordionTrigger>
        <AccordionContent>{links}</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
};

export default TroubleDisclosure;
