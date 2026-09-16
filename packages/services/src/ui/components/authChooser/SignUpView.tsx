/**
 * Account creation (`signup` view).
 *
 * Web: the account AND its self-custody identity are created at the identity
 * origin (`id.oxy.so`), in the same window a passkey sign-in uses — never on
 * this page, whatever its origin (one identity, two carriers). The sign-in
 * entry's "create an account" link opens that window directly; this view is
 * what `openAccountDialog('signup')` lands on, and offers the same one action.
 *
 * Native: Commons owns identity creation. Deep-link straight in when Commons is
 * installed, else lead with the "Get Commons" acquisition CTA.
 */

import type React from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import type { AccountDialogSnapshot } from '@oxy.so/core';
import { SubtleLink } from './primitives';
import { authChooserStyles as styles } from './styles';
import type { PasskeyMode, Theme, Translate } from './types';

interface SignUpViewProps {
  snapshot: AccountDialogSnapshot;
  theme: Theme;
  t: Translate;
  passkeyMode: PasskeyMode;
  /** Open the identity-origin window — web's only creation path. */
  onOpenHub: () => void;
  /** Deep-link into Commons' own identity-creation screen (installed only). */
  onCreateIdentityInCommons: () => void;
  /** Open the Commons store listing / landing page for this platform. */
  onGetCommons: () => void;
  onBackToSignIn: () => void;
}

const SignUpView: React.FC<SignUpViewProps> = ({
  snapshot,
  theme,
  t,
  passkeyMode,
  onOpenHub,
  onCreateIdentityInCommons,
  onGetCommons,
  onBackToSignIn,
}) => {
  if (passkeyMode === 'none') {
    const commonsInstalled = snapshot.commonsAvailability === 'available';
    return (
      <View style={styles.centeredBlock}>
        <Button
          variant="primary"
          onPress={commonsInstalled ? onCreateIdentityInCommons : onGetCommons}
          style={styles.primaryButton}
        >
          {commonsInstalled ? t('signup.createInCommons') : t('accountSwitcher.getCommons')}
        </Button>
        <SubtleLink label={t('signup.backToSignInLink')} theme={theme} onPress={onBackToSignIn} />
      </View>
    );
  }

  return (
    <View style={styles.centeredBlock}>
      <Text style={[styles.mutedText, { color: theme.colors.textSecondary }]}>
        {t('accountSwitcher.passkeyHint')}
      </Text>
      <Button variant="primary" onPress={onOpenHub} style={styles.primaryButton} testID="signup-open-identity">
        {t('signup.createAccount')}
      </Button>
      <SubtleLink label={t('signup.backToSignInLink')} theme={theme} onPress={onBackToSignIn} />
    </View>
  );
};

export default SignUpView;
