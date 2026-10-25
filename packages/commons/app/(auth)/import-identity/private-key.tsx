import { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  KeyManager,
  IdentityAlreadyExistsError,
  IdentityUnavailableError,
} from '@oxy.so/core/crypto';
import { useColors } from '@/hooks/useColors';
import { Button } from '@oxy.so/bloom/button';
import { KeyboardAwareScrollViewWrapper } from '@/components/ui';
import { useTranslation } from '@/lib/i18n';
import { useIdentity } from '@/hooks/useIdentity';
import { useIdentityStore } from '@/hooks/identity/identityStore';
import { IdentityMayExistError } from '@/hooks/identity/identityErrors';
import { shortenKey } from '@/utils/shorten-key';
import { extractAuthErrorMessage } from '@/utils/auth/errorUtils';
import { checkIfOffline } from '@/utils/auth/networkUtils';
import { usePreventScreenCapture } from '@/hooks/usePreventScreenCapture';
import { SECRET_INPUT_PROPS } from '@/lib/recovery-phrase/secret-input';

/**
 * Import an identity from a raw private key (hex).
 *
 * The recovery path for a user who exported their private key (via the Oxy
 * Identity "Private Key Export") but does NOT have their recovery phrase — the
 * phrase cannot be re-derived from the key (the key is the one-way PBKDF2 output
 * of the seed), but the key alone is full control of the account. Delegates the
 * store + sign-in (for a key that has an account) to
 * `importIdentityFromPrivateKey`, which mirrors the phrase importer minus the
 * mnemonic steps. A key without an account is registered at the username step.
 *
 * The key typed or pasted here is full control of the account, so the window
 * refuses screenshots and screen recording while this screen is mounted.
 */
export default function ImportPrivateKeyScreen() {
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  usePreventScreenCapture();
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

      // Online but the server could not be reached: do not advance (same guard
      // as the phrase importer). A key with no account goes to the username step.
      if (!offline && !result.synced && !result.needsUsername) {
        setError(t('importPrivateKey.syncFailed'));
        return;
      }

      // A raw-key import means the user has NO recovery phrase to acknowledge —
      // leave the phrase-acknowledged flag alone so the Security screen still
      // nudges them to create a proper phrase backup.
      setRecoveryPhraseAcknowledgedPersisted(false);

      router.replace('/(auth)/import-identity/username');
    } catch (err: unknown) {
      if (err instanceof IdentityMayExistError) {
        // This phone held a DIFFERENT identity, which is still recoverable, and
        // importing would overwrite it. Say so here, with the key it holds,
        // instead of silently bouncing back to the recovery screen: the person
        // can correct the words, or go back and choose Start over.
        setError(t('recovery.differentIdentity', { key: shortenKey(err.markerPublicKey) }));
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
    <View
      style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}
    >
      <KeyboardAwareScrollViewWrapper contentContainerStyle={styles.scrollContent}>
        <Text style={[styles.title, { color: colors.text }]}>{t('importPrivateKey.title')}</Text>
        <Text style={[styles.subtitle, { color: colors.text, opacity: 0.6 }]}>
          {t('importPrivateKey.subtitle')}
        </Text>

        <Textarea
          label={t('importPrivateKey.title')}
          rows={4}
          value={privateKey}
          onChangeText={handleChange}
          placeholder={t('importPrivateKey.placeholder')}
          disabled={isLoading}
          {...SECRET_INPUT_PROPS}
        />

        {error && <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>}

        <Button
          appearance="solid"
          tone="accent"
          onPress={handleImport}
          disabled={isLoading}
          loading={isLoading}
          className="mt-space-32"
        >
          {isLoading ? t('importPrivateKey.importing') : t('importPrivateKey.import')}
        </Button>

        <Button appearance="subtle" onPress={() => router.back()} disabled={isLoading}>
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
  errorText: {
    fontSize: 14,
    marginTop: 12,
    textAlign: 'center',
  },
});
