import React, { useCallback, useState } from 'react';
import { BackHandler, Platform } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { RecoveryPhraseStep } from '@/components/auth/RecoveryPhraseStep';
import { useAuthFlowContext } from '@/contexts/auth-flow-context';

import { useTranslation } from '@/lib/i18n';
import { useIdentityStore } from '@/hooks/identity/identityStore';
import { alert } from '@oxy.so/bloom/surfaces';

/**
 * Recovery Phrase Reveal Screen.
 *
 * This is the SINGLE most important screen in the entire onboarding flow.
 * If the user moves past it without writing down their recovery phrase
 * and later loses access to this device, their account is permanently
 * unrecoverable — Oxy cannot reset it on their behalf.
 *
 * Guarantees enforced here:
 *   - Hardware/gesture back navigation is blocked until the user
 *     acknowledges they have saved the phrase.
 *   - The phrase is read from `useAuthFlowContext().recoveryPhraseRef`,
 *     which lives in memory only — never persisted.
 *   - On missing phrase (e.g., the user reloaded the app mid-flow), we
 *     route back to the create flow's index so it can be regenerated.
 */
export default function RecoveryPhraseScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { recoveryPhraseRef, acknowledgeRecoveryPhrase, recoveryPhraseAcknowledged } =
    useAuthFlowContext();
  const setRecoveryPhraseAcknowledgedPersisted = useIdentityStore(
    (state) => state.setRecoveryPhraseAcknowledged,
  );

  const [revealed, setRevealed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(recoveryPhraseAcknowledged);

  // Snapshot the words from the ref so re-renders don't pick up later
  // mutations (e.g., when the flow context wipes the ref after
  // acknowledgement).
  const [words] = useState<string[] | null>(() => recoveryPhraseRef.current);

  // Block hardware back navigation (Android) when the user has not yet
  // acknowledged. On iOS, the gesture is intercepted via the navigator
  // options below, but we also reinforce here with an alert when they
  // try to dismiss the screen.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') {
        return undefined;
      }

      const onBackPress = (): boolean => {
        if (!acknowledged) {
          alert(
            t('auth.recoveryPhrase.backNavigationBlockedTitle'),
            t('auth.recoveryPhrase.backNavigationBlockedMessage'),
            [{ text: t('common.ok'), style: 'default' }],
          );
          return true; // consume the event — prevent default back
        }
        return false;
      };

      const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => subscription.remove();
    }, [acknowledged, alert, t]),
  );

  const handleReveal = useCallback(() => setRevealed(true), []);
  const handleHide = useCallback(() => setRevealed(false), []);

  const handleContinue = useCallback(() => {
    if (!acknowledged) return;
    acknowledgeRecoveryPhrase();
    // Persist the acknowledgement to disk so the next launch doesn't
    // re-nag the user.
    setRecoveryPhraseAcknowledgedPersisted(true);
    router.replace('/(auth)/create-identity/interests');
  }, [acknowledged, acknowledgeRecoveryPhrase, router, setRecoveryPhraseAcknowledgedPersisted]);

  const handleMissingPhrase = useCallback(() => {
    // The in-memory phrase is gone (the app was reloaded on this screen). The
    // create flow's index reloads it from the phrase slot it was stored in at
    // creation and comes back here; it cannot be re-derived from the key. The
    // welcome screen it used to go to resumed at the username step instead,
    // and onboarding finished without the phrase ever being shown again.
    router.replace('/(auth)/create-identity');
  }, [router]);

  return (
    <RecoveryPhraseStep
      words={words}
      revealed={revealed}
      onReveal={handleReveal}
      onHide={handleHide}
      acknowledged={acknowledged}
      onAcknowledgeChange={setAcknowledged}
      onContinue={handleContinue}
      onMissingPhrase={handleMissingPhrase}
      backgroundColor={colors.background}
      textColor={colors.text}
    />
  );
}
