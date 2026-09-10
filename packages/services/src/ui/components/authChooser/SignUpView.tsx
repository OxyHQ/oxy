/**
 * Account creation (`signup` view).
 *
 * Commons is ALWAYS the priority path (owner mandate) and leads everywhere it
 * appears: native shows only "Create your identity in Commons" (or "Get Commons"
 * first, when it is not installed); web on a first-party Oxy origin leads with
 * the SAME "Get Commons" CTA, with inline passkey creation offered UNDERNEATH as
 * the de-emphasized "don't want to install anything" alternative — never
 * co-equal, never a competing button. Anywhere else (a non-Oxy web origin,
 * before the b2 hub-relay ships) shows an honest "not available here yet"
 * handoff instead of a broken button.
 */

import type React from 'react';
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import type { AccountDialogSnapshot, OxyServices } from '@oxy.so/core';
import { isWebBrowser } from '../../utils/isWebBrowser';
import { Dividerish, SubtleLink } from './primitives';
import { authChooserStyles as styles } from './styles';
import type { PasskeyMode, Theme, Translate } from './types';
import { useUsernameAvailability, type UsernameStatus } from './useUsernameAvailability';

interface SignUpViewProps {
  snapshot: AccountDialogSnapshot;
  theme: Theme;
  t: Translate;
  oxyServices: OxyServices;
  passkeyMode: PasskeyMode;
  onCreateWithPasskey: (username: string) => void;
  createPending: boolean;
  /** Open the auth.oxy.so hub popup (b2) — the 'hub' mode's only path. */
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
  oxyServices,
  passkeyMode,
  onCreateWithPasskey,
  createPending,
  onOpenHub,
  onCreateIdentityInCommons,
  onGetCommons,
  onBackToSignIn,
}) => {
  const [username, setUsername] = useState('');
  const { status: usernameStatus, check: checkUsername } = useUsernameAvailability(oxyServices, t);
  const canSubmit = username.trim().length >= 3 && usernameStatus === 'available' && !createPending;

  // Native — Commons owns identity creation. Deep-link straight in when it is
  // installed, else lead with the same "Get Commons" acquisition CTA.
  if (!isWebBrowser()) {
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

  // Web, first-party Oxy origin. Commons leads with a "Get Commons" CTA; passkey
  // creation is the de-emphasized alternative underneath for someone who doesn't
  // want to install anything — a secondary button introduced by its own "No
  // Commons?" framing, the same subordination the sign-in surfaces use.
  if (passkeyMode === 'direct') {
    return (
      <View style={styles.signInBlock}>
        <Text style={[styles.qrHeadline, { color: theme.colors.text }]}>
          {t('signup.commonsHeadline')}
        </Text>
        <Text style={[styles.mutedText, { color: theme.colors.textSecondary }]}>
          {t('signup.commonsExplainer')}
        </Text>
        <Button variant="primary" onPress={onGetCommons} style={styles.primaryButton}>
          {t('accountSwitcher.getCommons')}
        </Button>

        <Dividerish theme={theme} label={t('signin.or')} />

        <Text style={[styles.mutedText, { color: theme.colors.textSecondary }]}>
          {t('signup.passkeyAlternative')}
        </Text>
        <TextInput
          style={[styles.usernameInput, { borderColor: theme.colors.border, color: theme.colors.text }]}
          placeholder={t('signup.usernamePlaceholder')}
          placeholderTextColor={theme.colors.textSecondary}
          value={username}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          onChangeText={(value) => {
            setUsername(value);
            checkUsername(value.trim());
          }}
          testID="signup-username-input"
        />
        <UsernameStatusText status={usernameStatus} theme={theme} t={t} />
        <Button
          variant="secondary"
          onPress={() => onCreateWithPasskey(username.trim())}
          disabled={!canSubmit}
          style={styles.secondaryButton}
          testID="signup-create-button"
        >
          {createPending ? t('signup.creating') : t('signup.createAccount')}
        </Button>
        <SubtleLink label={t('signup.backToSignInLink')} theme={theme} onPress={onBackToSignIn} />
      </View>
    );
  }

  // Web, non-Oxy origin (b2): a passkey ceremony cannot run locally here — the
  // same WebAuthn RP-ID boundary the sign-in surfaces hit — so this opens the
  // auth.oxy.so hub popup. Completing EITHER a sign-in OR a fresh sign-up there
  // relays the resulting session back through the SAME poll/socket engine.
  return (
    <View style={styles.centeredBlock}>
      <Text style={[styles.mutedText, { color: theme.colors.textSecondary }]}>
        {t('signup.hubExplainer')}
      </Text>
      <Button variant="primary" onPress={onOpenHub} style={styles.primaryButton}>
        {t('signup.continueInWindow')}
      </Button>
      <SubtleLink label={t('signup.backToSignInLink')} theme={theme} onPress={onBackToSignIn} />
    </View>
  );
};

/** The inline availability verdict. Network FAILURES are toasted, never shown here. */
const UsernameStatusText: React.FC<{ status: UsernameStatus; theme: Theme; t: Translate }> = ({
  status,
  theme,
  t,
}) => {
  if (status === 'idle') return null;
  if (status === 'checking') {
    return (
      <Text style={[styles.mutedText, { color: theme.colors.textSecondary }]}>
        {t('signup.usernameChecking')}
      </Text>
    );
  }
  if (status === 'available') {
    return (
      <Text style={[styles.mutedText, { color: theme.colors.success }]}>
        {t('signup.usernameAvailable')}
      </Text>
    );
  }
  return (
    <Text style={[styles.mutedText, { color: theme.colors.error }]}>
      {t('signup.usernameTaken')}
    </Text>
  );
};

export default SignUpView;
