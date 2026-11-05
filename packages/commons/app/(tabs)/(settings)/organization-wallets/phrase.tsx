import { useCallback, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { getOrganizationRecoveryPhrase } from '@oxy.so/core/crypto';
import { Screen, StackHeader, ImportantBanner } from '@/components/ui';
import { RecoveryPhraseGrid } from '@/components/identity/RecoveryPhraseGrid';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { authenticate, getErrorMessage, hasLocalConfirmation } from '@/lib/biometricAuth';

type Reveal =
  | { kind: 'hidden' }
  | { kind: 'revealed'; words: string[] }
  | { kind: 'notStored' }
  | { kind: 'gateFailed'; message: string };

/**
 * The organization's phrase, to give another owner or admin in person
 * (ADR 0061 D5). Read only after the device's biometric or passcode, never
 * copied, logged or kept anywhere but the slot it came from.
 */
export default function OrganizationPhraseScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  const [reveal, setReveal] = useState<Reveal>({ kind: 'hidden' });

  const show = useCallback(async () => {
    if (!accountId) return;
    if (await hasLocalConfirmation()) {
      const auth = await authenticate(t('organizationWallet.phrase.biometricReason'));
      if (!auth.success) {
        setReveal({ kind: 'gateFailed', message: getErrorMessage(auth.error) });
        return;
      }
    }
    const phrase = await getOrganizationRecoveryPhrase(accountId);
    setReveal(phrase ? { kind: 'revealed', words: phrase.split(' ') } : { kind: 'notStored' });
  }, [accountId, t]);

  return (
    <Screen gap={16}>
      <StackHeader
        title={t('organizationWallet.phrase.title')}
        subtitle={t('organizationWallet.phrase.subtitle')}
        onBack={() => router.back()}
        backAccessibilityLabel={t('common.back')}
      />
      {reveal.kind === 'revealed' ? (
        <>
          <RecoveryPhraseGrid words={reveal.words} textColor={colors.text} />
          <Button appearance="outline" onPress={() => setReveal({ kind: 'hidden' })}>
            {t('organizationWallet.phrase.hide')}
          </Button>
        </>
      ) : reveal.kind === 'notStored' ? (
        <ImportantBanner type="info">{t('organizationWallet.phrase.notStored')}</ImportantBanner>
      ) : (
        <>
          {reveal.kind === 'gateFailed' ? (
            <ImportantBanner type="error">{reveal.message}</ImportantBanner>
          ) : null}
          <Button appearance="solid" tone="accent" onPress={() => void show()}>
            {t('organizationWallet.phrase.reveal')}
          </Button>
        </>
      )}
    </Screen>
  );
}
