import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@oxy.so/bloom/button';
import { IDENTITY_ERROR_CODES } from '@oxy.so/contracts';
import { IdentityAlreadyExistsError, KeyManager } from '@oxy.so/core/crypto';
import { useOxy } from '@oxy.so/services';
import { RecoveryPhraseStep } from '@/components/auth/RecoveryPhraseStep';
import { useIdentityStore } from '@/hooks/identity/identityStore';
import { useColors } from '@/hooks/useColors';
import { useIdentity } from '@/hooks/useIdentity';
import { useTranslation } from '@/lib/i18n';
import { awaitLinkCompletion } from '@/lib/link-account/awaitLinkCompletion';
import { setLinkInProgress } from '@/lib/link-account/linkInProgress';

type Step =
  | { name: 'loading' }
  | { name: 'confirm'; username: string | null }
  | { name: 'working' }
  | { name: 'phrase'; words: string[] }
  | { name: 'code'; code: string }
  | { name: 'error'; message: string };

/**
 * Link the web account a scanned code names (ADR 0029 D3).
 *
 * "Link this account" creates this phone's key (the same way creating an
 * identity does, without registering a new account) and shows its recovery
 * phrase for the mandatory acknowledgement — before anything is linked, since
 * the signed-in account leaves onboarding at once. Then it signs the link proof
 * over the code's challenge and shows the 6-digit code the other screen shows
 * for that key. The person confirms there with a code sent to the account's
 * email; once the request completes, this key signs in as the account.
 */
export default function LinkAccountConfirmScreen() {
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const { createIdentity, syncIdentity } = useIdentity();
  const setRecoveryPhraseAcknowledged = useIdentityStore((state) => state.setRecoveryPhraseAcknowledged);
  const [revealed, setRevealed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const { id, c } = useLocalSearchParams<{ id: string; c: string }>();
  // A code without both halves never names a request.
  const [step, setStep] = useState<Step>(() =>
    id && c ? { name: 'loading' } : { name: 'error', message: t('linkAccount.expired') },
  );
  const aborter = useRef(new AbortController());

  useEffect(
    () => () => {
      aborter.current.abort();
      setLinkInProgress(false);
    },
    [],
  );

  useEffect(() => {
    if (!id || !c) return;
    oxyServices
      .identity.links.get(id)
      .then((state) =>
        setStep(
          state.status === 'pending' && Date.now() < state.expiresAt
            ? { name: 'confirm', username: state.username }
            : { name: 'error', message: t('linkAccount.expired') },
        ),
      )
      .catch(() => setStep({ name: 'error', message: t('linkAccount.expired') }));
  }, [id, c, oxyServices, t]);

  const fail = useCallback(
    (error: unknown) => {
      setLinkInProgress(false);
      const code = (error as { code?: unknown } | null)?.code;
      setStep({
        name: 'error',
        message: code === IDENTITY_ERROR_CODES.rootAlreadyLinked ? t('linkAccount.alreadyLinked') : t('linkAccount.failed'),
      });
    },
    [t],
  );

  /** Sign the proof, show the code, wait for the confirmation, sign in. */
  const finish = useCallback(async () => {
    if (!id || !c) return;
    setStep({ name: 'working' });
    try {
      const { code } = await oxyServices.identity.links.sign(id, c);
      setStep({ name: 'code', code });

      const outcome = await awaitLinkCompletion({
        getState: () => oxyServices.identity.links.get(id),
        signal: aborter.current.signal,
      });
      if (outcome === 'aborted') return;
      setLinkInProgress(false);
      if (outcome !== 'completed') {
        setStep({ name: 'error', message: t('linkAccount.expired') });
        return;
      }
      // The key is the account's root now: sign in with it.
      await syncIdentity();
      router.replace('/');
    } catch (error) {
      fail(error);
    }
  }, [id, c, oxyServices, syncIdentity, router, t, fail]);

  /** This phone's key, and its phrase shown before anything is linked. */
  const link = useCallback(async () => {
    setStep({ name: 'working' });
    setLinkInProgress(true);
    try {
      // A new key — or, after an earlier attempt that did not finish, the one
      // this phone already made and has not registered.
      let words: string[] | null;
      try {
        words = (await createIdentity({ skipSync: true })).recoveryPhrase;
      } catch (error) {
        if (!(error instanceof IdentityAlreadyExistsError)) throw error;
        words = (await KeyManager.getRecoveryMnemonic())?.split(' ') ?? null;
      }
      if (words) {
        setStep({ name: 'phrase', words });
        return;
      }
      await finish();
    } catch (error) {
      fail(error);
    }
  }, [createIdentity, finish, fail]);

  const container = [styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }];

  switch (step.name) {
    case 'phrase':
      return (
        <RecoveryPhraseStep
          words={step.words}
          revealed={revealed}
          onReveal={() => setRevealed(true)}
          onHide={() => setRevealed(false)}
          acknowledged={acknowledged}
          onAcknowledgeChange={setAcknowledged}
          onContinue={() => {
            if (!acknowledged) return;
            setRecoveryPhraseAcknowledged(true);
            void finish();
          }}
          onMissingPhrase={() => void finish()}
          backgroundColor={colors.background}
          textColor={colors.text}
        />
      );
    case 'confirm':
      return (
        <View style={container}>
          <View style={styles.body}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
              {t('linkAccount.confirmTitle', { username: step.username ?? '' })}
            </Text>
            <Text style={[styles.text, { color: colors.text }]}>{t('linkAccount.confirmBody')}</Text>
          </View>
          <View style={styles.actions}>
            <Button appearance="solid" tone="accent" onPress={() => void link()} testID="link-account-confirm">
              {t('linkAccount.confirmAction')}
            </Button>
            <Button appearance="subtle" onPress={() => router.back()}>{t('common.back')}</Button>
          </View>
        </View>
      );
    case 'code':
      return (
        <View style={container}>
          <View style={styles.body}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('linkAccount.codeTitle')}</Text>
            <Text style={[styles.text, { color: colors.text }]}>{t('linkAccount.codeBody')}</Text>
            <Text
              accessibilityLabel={step.code.split('').join(' ')}
              style={[styles.code, { color: colors.text }]}
              testID="link-account-code"
            >
              {`${step.code.slice(0, 3)} ${step.code.slice(3)}`}
            </Text>
          </View>
          <View style={styles.waiting}>
            <ActivityIndicator color={colors.text} />
            <Text style={[styles.text, { color: colors.text }]}>{t('linkAccount.waiting')}</Text>
          </View>
        </View>
      );
    case 'error':
      return (
        <View style={container}>
          <View style={styles.body}>
            <Text accessibilityRole="alert" style={[styles.text, { color: colors.error }]}>{step.message}</Text>
          </View>
          <View style={styles.actions}>
            <Button appearance="solid" tone="accent" onPress={() => router.replace('/(auth)/link-account/scan')}>
              {t('linkAccount.scanAgain')}
            </Button>
            <Button appearance="subtle" onPress={() => router.replace('/(auth)/welcome')}>{t('common.back')}</Button>
          </View>
        </View>
      );
    default:
      return (
        <View style={[container, styles.center]}>
          <ActivityIndicator color={colors.text} />
          <Text style={[styles.text, { color: colors.text }]}>{t('linkAccount.loading')}</Text>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24, justifyContent: 'space-between' },
  center: { justifyContent: 'center', alignItems: 'center', gap: 12 },
  body: { gap: 12 },
  title: { fontSize: 28, fontWeight: '600' },
  text: { fontSize: 16, lineHeight: 24, opacity: 0.8 },
  code: { fontSize: 44, fontWeight: '700', letterSpacing: 4, textAlign: 'center', marginTop: 24 },
  actions: { gap: 12 },
  waiting: { flexDirection: 'row', gap: 12, alignItems: 'center', justifyContent: 'center' },
});
