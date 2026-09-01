import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { RecoveryPhraseService } from '@oxyhq/core';
import { useColors } from '@/hooks/useColors';
import { Button, KeyboardAwareScrollViewWrapper, StackHeader } from '@/components/ui';
import { PhraseInputGrid } from '@/components/auth/PhraseInputGrid';
import { useTranslation } from '@/lib/i18n';
import { useRotateKeyFlow } from '@/contexts/rotate-key-flow-context';
import { RECOVERY_PHRASE_LENGTH } from '@/constants/auth';

/**
 * Path B step: capture the CURRENT recovery phrase so the rotation can be
 * authorized by re-deriving the key it controls. The phrase is stashed in the
 * flow's in-memory ref only — it is never persisted.
 */
export default function RotateKeyCurrentPhraseScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { currentPhraseRef } = useRotateKeyFlow();

  const [phraseWords, setPhraseWords] = useState<string[]>(
    () => new Array(RECOVERY_PHRASE_LENGTH).fill(''),
  );
  const [error, setError] = useState<string | null>(null);

  const handleWordChange = useCallback((index: number, word: string) => {
    setPhraseWords((prev) => {
      const next = [...prev];
      next[index] = word.toLowerCase().trim();
      return next;
    });
    setError(null);
  }, []);

  const handlePaste = useCallback((text: string) => {
    const words = text.trim().toLowerCase().split(/\s+/);
    if (words.length === RECOVERY_PHRASE_LENGTH || words.length === 24) {
      setPhraseWords(words.slice(0, RECOVERY_PHRASE_LENGTH));
    }
  }, []);

  const handleContinue = useCallback(() => {
    const phrase = phraseWords.join(' ');
    if (!RecoveryPhraseService.validatePhrase(phrase)) {
      setError(t('rotateKey.currentPhrase.invalid'));
      return;
    }
    currentPhraseRef.current = phrase;
    router.push('/(tabs)/(settings)/rotate-key/recovery-phrase');
  }, [phraseWords, currentPhraseRef, router, t]);

  return (
    <KeyboardAwareScrollViewWrapper reserveTabBarFootprint contentContainerStyle={styles.content}>
      <StackHeader
        title={t('rotateKey.currentPhrase.title')}
        subtitle={t('rotateKey.currentPhrase.subtitle')}
        onBack={() => router.back()}
        backAccessibilityLabel={t('common.back')}
      />

      <PhraseInputGrid
        words={phraseWords}
        onWordChange={handleWordChange}
        onPaste={handlePaste}
      />

      {error && <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>}

      <Button variant="primary" onPress={handleContinue} style={styles.primaryButton}>
        {t('rotateKey.currentPhrase.continue')}
      </Button>
    </KeyboardAwareScrollViewWrapper>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 22,
    paddingTop: 24,
    gap: 16,
  },
  errorText: {
    fontSize: 13,
    textAlign: 'center',
  },
  primaryButton: {
    marginTop: 8,
  },
});
