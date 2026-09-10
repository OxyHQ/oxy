import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyManager, IdentityAlreadyExistsError, IdentityUnavailableError } from '@oxy.so/core';
import { useColors } from '@/hooks/useColors';
import { Fonts } from '@/constants/theme';
import { withAlpha } from '@/utils/color';
import { Button, KeyboardAwareScrollViewWrapper } from '@/components/ui';
import { useTranslation } from '@/lib/i18n';
import { useIdentity } from '@/hooks/useIdentity';
import { useIdentityStore } from '@/hooks/identity/identityStore';
import { IdentityMayExistError } from '@/hooks/identity/identityErrors';
import { extractAuthErrorMessage } from '@/utils/auth/errorUtils';
import { checkIfOffline } from '@/utils/auth/networkUtils';

/**
 * Import an identity from a raw private key (hex).
 *
 * The recovery path for a user who exported their private key (via the Oxy
 * Identity "Private Key Export") but does NOT have their recovery phrase — the
 * phrase cannot be re-derived from the key (the key is the one-way PBKDF2 output
 * of the seed), but the key alone is full control of the account. Delegates the
 * store + register-if-needed + sign-in to `importIdentityFromPrivateKey`, which
 * mirrors the phrase importer minus the mnemonic steps.
 */
export default function ImportPrivateKeyScreen() {
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { importIdentityFromPrivateKey } = useIdentity();
  const setRecoveryPhraseAcknowledgedPersisted = useIdentityStore(
    (state) => state.setRecoveryPhraseAcknowledged,
  );

  const [privateKey, setPrivateKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleChange = useCallback((text: string) => {
    // Accept pasted values with whitespace / 0x prefix; validation is on the key body.
    setPrivateKey(text.replace(/\s+/g, '').replace(/^0x/i, ''));
    setError(null);
  }, []);

  const handleImport = useCallback(async () => {
    const key = privateKey.trim().toLowerCase();

    if (!KeyManager.isValidPrivateKey(key)) {
      setError(t('importPrivateKey.invalidKey'));
      return;
    }

    setError(null);
    setIsLoading(true);
    try {
      const offline = await checkIfOffline();
      const result = await importIdentityFromPrivateKey(key, { skipSync: offline });

      // Online but server sync failed: do not advance — username would call
      // authenticated APIs with no session (same guard as the phrase importer).
      if (!offline && !result.synced) {
        setError(t('importPrivateKey.syncFailed'));
        return;
      }

      // A raw-key import means the user has NO recovery phrase to acknowledge —
      // leave the phrase-acknowledged flag alone so the Security screen still
      // nudges them to create a proper phrase backup.
      setRecoveryPhraseAcknowledgedPersisted(false);

      router.replace(
        offline
          ? '/(auth)/import-identity/notifications'
          : '/(auth)/import-identity/username',
      );
    } catch (err: unknown) {
      if (err instanceof IdentityMayExistError) {
        router.replace('/(auth)/recover-identity');
        return;
      }
      if (err instanceof IdentityUnavailableError) {
        router.replace('/(auth)');
        return;
      }
      if (err instanceof IdentityAlreadyExistsError) {
        setError(t('importPrivateKey.identityAlreadyExists'));
      } else {
        setError(extractAuthErrorMessage(err, t('importPrivateKey.failed')));
      }
    } finally {
      setIsLoading(false);
    }
  }, [privateKey, importIdentityFromPrivateKey, router, setRecoveryPhraseAcknowledgedPersisted, t]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <KeyboardAwareScrollViewWrapper contentContainerStyle={styles.scrollContent}>
        <Text style={[styles.title, { color: colors.text }]}>{t('importPrivateKey.title')}</Text>
        <Text style={[styles.subtitle, { color: colors.text, opacity: 0.6 }]}>
          {t('importPrivateKey.subtitle')}
        </Text>

        <TextInput
          value={privateKey}
          onChangeText={handleChange}
          placeholder={t('importPrivateKey.placeholder')}
          placeholderTextColor={withAlpha(colors.text, 0.4)}
          editable={!isLoading}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          spellCheck={false}
          style={[
            styles.input,
            { color: colors.text, borderColor: withAlpha(colors.text, 0.2), backgroundColor: colors.card },
          ]}
        />

        {error && <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>}

        <Button
          variant="primary"
          onPress={handleImport}
          disabled={isLoading}
          loading={isLoading}
          style={styles.primaryButton}
        >
          {isLoading ? t('importPrivateKey.importing') : t('importPrivateKey.import')}
        </Button>

        <Button variant="ghost" onPress={() => router.back()} disabled={isLoading}>
          {t('common.back')}
        </Button>
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
    justifyContent: 'center',
  },
  title: {
    fontSize: 34,
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
  input: {
    minHeight: 96,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    fontSize: 15,
    fontFamily: Fonts.mono,
    textAlignVertical: 'top',
  },
  primaryButton: {
    marginTop: 32,
  },
  errorText: {
    fontSize: 14,
    marginTop: 12,
    textAlign: 'center',
  },
});
