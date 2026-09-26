import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { Button } from '@oxy.so/bloom/button';
import {
  KeyboardAwareScrollViewWrapper,
} from '@/components/ui';
import { PhraseInputGrid } from '@/components/auth/PhraseInputGrid';
import { useTranslation } from '@/lib/i18n';

interface ImportPhraseStepProps {
  phraseWords: string[];
  onWordChange: (index: number, word: string) => void;
  onPaste: (text: string) => void;
  onImport: () => void;
  error: string | null;
  isLoading: boolean;
  /**
   * Optional handler for the "restore from encrypted backup" affordance. When
   * provided, a ghost button is rendered so the user can recover from their
   * Oxy-stored encrypted backup instead of retyping the phrase by hand.
   */
  onRestoreFromBackup?: () => void;
  /**
   * Optional handler for the "import with private key" affordance. When
   * provided, a ghost button lets a user who exported their raw private key
   * (but has no recovery phrase) recover their account directly from the key.
   */
  onImportPrivateKey?: () => void;
  /**
   * Optional handler for "I have an Oxy account on the web": link that
   * passkey account to this phone by scanning auth.oxy.so/link-commons.
   */
  onLinkWebAccount?: () => void;
  backgroundColor: string;
  textColor: string;
}

/**
 * Import phrase step component for entering recovery phrase
 */
export function ImportPhraseStep({
  phraseWords,
  onWordChange,
  onPaste,
  onImport,
  error,
  isLoading,
  onRestoreFromBackup,
  onImportPrivateKey,
  onLinkWebAccount,
  backgroundColor,
  textColor,
}: ImportPhraseStepProps) {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  return (
    <View style={[styles.container, { backgroundColor, paddingTop: insets.top }]}>
      <KeyboardAwareScrollViewWrapper
        contentContainerStyle={[styles.scrollContent, styles.stepContainer]}
      >
        <Text style={[styles.title, { color: textColor }]}>{t('auth.importStep.title')}</Text>
        <Text style={[styles.subtitle, { color: textColor, opacity: 0.6 }]}>
          {t('auth.importStep.subtitle')}
        </Text>

        <PhraseInputGrid
          words={phraseWords}
          onWordChange={onWordChange}
          onPaste={onPaste}
          editable={!isLoading}
        />

        {error && <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>}

        <Button appearance="solid" tone="accent" onPress={onImport} disabled={isLoading} loading={isLoading} className="mt-space-32">{t('auth.importStep.import')}</Button>

        {onLinkWebAccount && (
          <Button appearance="subtle" onPress={onLinkWebAccount} disabled={isLoading}>{t('linkAccount.entry')}</Button>
        )}

        {onRestoreFromBackup && (
          <Button appearance="subtle" onPress={onRestoreFromBackup} disabled={isLoading}>{t('restoreBackup.entry')}</Button>
        )}

        {onImportPrivateKey && (
          <Button appearance="subtle" onPress={onImportPrivateKey} disabled={isLoading}>{t('importPrivateKey.entry')}</Button>
        )}

        <Button appearance="subtle" onPress={() => router.push('/(auth)/create-identity')} disabled={isLoading}>{t('auth.importStep.createInstead')}</Button>
      </KeyboardAwareScrollViewWrapper>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    padding: 24,
    paddingTop: 60,
  },
  stepContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  title: {
    fontSize: 38,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 32,
    lineHeight: 22,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 14,
    marginTop: 8,
    marginBottom: 8,
    textAlign: 'center',
  },
});

