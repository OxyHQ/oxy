import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { RecoveryPhraseService } from '@oxyhq/core';
import { alert } from '@oxyhq/bloom';
import { useColors } from '@/hooks/useColors';
import { RecoveryPhraseStep } from '@/components/auth/RecoveryPhraseStep';
import { CenteredState, Button, useScreenBottomPad } from '@/components/ui';
import { useTranslation } from '@/lib/i18n';
import { useRotateKeyFlow } from '@/contexts/rotate-key-flow-context';

/**
 * Reveal + save the NEW recovery phrase for a key rotation.
 *
 * Reuses the onboarding `RecoveryPhraseStep` contract: the phrase must be
 * revealed and acknowledged before the user can continue, and back navigation is
 * blocked until then. Critically, the new identity is derived and shown HERE —
 * BEFORE any server call — and stashed in the flow's in-memory ref so the exact
 * phrase shown is the one committed on the confirm step. If the phrase is lost,
 * the rotated key is unrecoverable.
 */
export default function RotateKeyRecoveryPhraseScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { pendingIdentityRef } = useRotateKeyFlow();
  const contentBottomPad = useScreenBottomPad();

  const [words, setWords] = useState<string[] | null>(
    () => pendingIdentityRef.current?.words ?? null,
  );
  const [deriveError, setDeriveError] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [deriveNonce, setDeriveNonce] = useState(0);
  // In-flight derivation shared across a strict-mode double-invoke so we never
  // start two derivations (which would show one phrase but commit another).
  const deriveInFlightRef = useRef<ReturnType<typeof RecoveryPhraseService.derivePendingIdentity> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Derive the NEW identity once and remember it in the flow ref. The ref is the
  // source of truth, so writing it is never gated on the per-run cancel flag —
  // only the React state update is (to avoid a set-after-unmount).
  useEffect(() => {
    if (pendingIdentityRef.current) {
      setWords(pendingIdentityRef.current.words);
      return;
    }
    let active = true;
    setDeriveError(false);
    void (async () => {
      try {
        if (!deriveInFlightRef.current) {
          deriveInFlightRef.current = RecoveryPhraseService.derivePendingIdentity();
        }
        const pending = await deriveInFlightRef.current;
        pendingIdentityRef.current = pending;
        if (active && mountedRef.current) setWords(pending.words);
      } catch {
        deriveInFlightRef.current = null;
        if (active && mountedRef.current) setDeriveError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [pendingIdentityRef, deriveNonce]);

  // Block hardware back until the user acknowledges saving the new phrase —
  // mirrors the onboarding recovery-phrase contract.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') return undefined;
      const onBackPress = (): boolean => {
        if (!acknowledged) {
          alert(
            t('rotateKey.backBlockedTitle'),
            t('rotateKey.backBlockedMessage'),
            [{ text: t('common.ok'), style: 'default' }],
          );
          return true;
        }
        return false;
      };
      const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => subscription.remove();
    }, [acknowledged, t]),
  );

  const handleContinue = useCallback(() => {
    if (!acknowledged) return;
    router.push('/(tabs)/(settings)/rotate-key/confirm');
  }, [acknowledged, router]);

  const handleRetry = useCallback(() => {
    setDeriveError(false);
    setDeriveNonce((n) => n + 1);
  }, []);

  if (deriveError) {
    return (
      <CenteredState
        icon="key-alert-outline"
        iconColor={colors.error}
        title={t('rotateKey.newPhrase.error')}
        action={
          <Button variant="primary" onPress={handleRetry}>
            {t('rotateKey.newPhrase.retry')}
          </Button>
        }
      />
    );
  }

  if (!words) {
    return <CenteredState loading title={t('rotateKey.newPhrase.deriving')} />;
  }

  return (
    <RecoveryPhraseStep
      words={words}
      revealed={revealed}
      onReveal={() => setRevealed(true)}
      onHide={() => setRevealed(false)}
      acknowledged={acknowledged}
      onAcknowledgeChange={setAcknowledged}
      onContinue={handleContinue}
      backgroundColor={colors.background}
      textColor={colors.text}
      contentBottomPad={contentBottomPad}
    />
  );
}
