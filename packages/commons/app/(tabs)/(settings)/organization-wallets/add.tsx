import { useCallback, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { organizationKeyFromPhrase, storeOrganizationKey } from '@oxy.so/core/crypto';
import { Screen, StackHeader, ImportantBanner, LoadingState } from '@/components/ui';
import { PhraseInputGrid } from '@/components/auth/PhraseInputGrid';
import { useTranslation } from '@/lib/i18n';
import {
  useInvalidateOrganizationWallets,
  useOrganizationWallet,
} from '@/hooks/organization-wallet/useOrganizationWallets';

/** An organization phrase is 24 words (ADR 0061 D2). */
const ORGANIZATION_PHRASE_WORDS = 24;

/**
 * Add an organization's key you were given (ADR 0061 D5): its 24-word phrase,
 * entered here. Nothing is sent anywhere: the phrase must derive the key the
 * organization's DID publishes as `#key-1` right now, and only then is it kept
 * on this phone.
 */
export default function AddOrganizationKeyScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  const wallet = useOrganizationWallet(accountId ?? null);
  const invalidate = useInvalidateOrganizationWallets();
  const [words, setWords] = useState<string[]>(() => new Array(ORGANIZATION_PHRASE_WORDS).fill(''));
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const onWordChange = useCallback((index: number, word: string) => {
    setProblem(null);
    setWords((current) => current.map((value, i) => (i === index ? word : value)));
  }, []);

  const onPaste = useCallback((text: string) => {
    setProblem(null);
    const pasted = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    setWords(new Array(ORGANIZATION_PHRASE_WORDS).fill('').map((_, index) => pasted[index] ?? ''));
  }, []);

  const submit = useCallback(async () => {
    const current = wallet.data?.state.publicKey?.toLowerCase() ?? null;
    if (!accountId || !current) {
      setProblem(t('organizationWallet.add.noKey'));
      return;
    }
    setWorking(true);
    try {
      const phrase = words.map((word) => word.trim().toLowerCase()).join(' ');
      let key: { privateKey: string; publicKey: string };
      try {
        key = await organizationKeyFromPhrase(phrase);
      } catch {
        setProblem(t('organizationWallet.add.invalid'));
        return;
      }
      if (key.publicKey.toLowerCase() !== current) {
        setProblem(t('organizationWallet.add.mismatch'));
        return;
      }
      await storeOrganizationKey(accountId, { ...key, mnemonic: phrase });
      await invalidate();
      toast.success(t('organizationWallet.add.done'));
      router.back();
    } catch {
      setProblem(t('organizationWallet.errors.generic'));
    } finally {
      setWorking(false);
    }
  }, [accountId, invalidate, router, t, wallet.data, words]);

  if (wallet.isPending) return <LoadingState />;

  const complete = words.every((word) => word.trim().length > 0);
  return (
    <Screen gap={16}>
      <StackHeader
        title={t('organizationWallet.add.title')}
        subtitle={t('organizationWallet.add.subtitle')}
        onBack={() => router.back()}
        backAccessibilityLabel={t('common.back')}
      />
      <PhraseInputGrid
        words={words}
        onWordChange={onWordChange}
        onPaste={onPaste}
        editable={!working}
      />
      {problem ? <ImportantBanner type="error">{problem}</ImportantBanner> : null}
      <Button
        appearance="solid"
        tone="accent"
        onPress={() => void submit()}
        loading={working}
        disabled={working || !complete}
        testID="org-key-add"
      >
        {working ? t('organizationWallet.add.working') : t('organizationWallet.add.submit')}
      </Button>
    </Screen>
  );
}
