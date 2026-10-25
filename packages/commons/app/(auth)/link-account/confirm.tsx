import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@oxy.so/bloom/button';
import { IDENTITY_ERROR_CODES } from '@oxy.so/contracts';
import {
  deriveIdentityLinkCode,
  IdentityAlreadyExistsError,
  KeyManager,
} from '@oxy.so/core/crypto';
import { handleHttpError } from '@oxy.so/core';
import type { IdentityLinkState } from '@oxy.so/contracts';
import { useOxy } from '@oxy.so/services';
import { RecoveryPhraseStep } from '@/components/auth/RecoveryPhraseStep';
import {
  persistOnboardingFlow,
  persistRecoveryPhraseAcknowledged,
  useIdentityStore,
} from '@/hooks/identity/identityStore';
import { useColors } from '@/hooks/useColors';
import { useIdentity } from '@/hooks/useIdentity';
import { useTranslation } from '@/lib/i18n';
import { awaitLinkCompletion } from '@/lib/link-account/awaitLinkCompletion';
import { setLinkInProgress } from '@/lib/link-account/linkInProgress';
import {
  abandonPendingLink,
  clearPendingLink,
  pendingLinkVerdict,
  persistPendingLink,
  readPendingLink,
  type PendingLink,
} from '@/lib/link-account/pendingLink';

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
 *
 * The key made here is a PENDING link until the request completes
 * (`lib/link-account/pendingLink.ts`). Opened again for the same request (the
 * app was closed half-way; onboarding resumes here), the screen picks up where
 * the request stands. Leaving it removes the key when nothing can ever sign in
 * with it, so onboarding never offers to register it as a new account.
 */
export default function LinkAccountConfirmScreen() {
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const { createIdentity, syncIdentity } = useIdentity();
  const setRecoveryPhraseAcknowledged = useIdentityStore(
    (state) => state.setRecoveryPhraseAcknowledged,
  );
  const [revealed, setRevealed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const { id, c } = useLocalSearchParams<{ id: string; c: string }>();
  // A code without both halves never names a request.
  const [step, setStep] = useState<Step>(() =>
    id && c ? { name: 'loading' } : { name: 'error', message: t('linkAccount.expired') },
  );
  const aborter = useRef(new AbortController());

  /** This screen made, or resumed with, a key for the request: leaving it must decide that key. */
  const engagedRef = useRef(false);

  /** The request, or `null` when it is gone; throws when it cannot be read. */
  const readLink = useCallback(
    async (linkId: string): Promise<IdentityLinkState | null> => {
      try {
        return await oxyServices.identity.links.get(linkId);
      } catch (error) {
        if (handleHttpError(error).status === 404) return null;
        throw error;
      }
    },
    [oxyServices],
  );

  /**
   * Leave this link for good: remove the key made for it if nothing can ever
   * sign in with it (never while the other screen can still confirm it).
   */
  const abandon = useCallback(async () => {
    const pending = await readPendingLink();
    if (!pending || pending.linkId !== id) return;
    const outcome = await abandonPendingLink({
      link: pending,
      getState: () => readLink(pending.linkId),
      currentPublicKey: () => KeyManager.getPublicKey(),
      isKeyRegistered: async (key) => (await oxyServices.auth.isKeyRegistered(key)).registered,
      deleteKey: async () => {
        // An unregistered key nobody can sign in with: no Oxy backup to keep.
        await KeyManager.deleteIdentity(true, false, true);
        await Promise.all([persistOnboardingFlow(null), persistRecoveryPhraseAcknowledged(false)]);
      },
    }).catch(() => 'kept' as const);
    if (outcome !== 'kept') setRecoveryPhraseAcknowledged(false);
  }, [id, oxyServices, readLink, setRecoveryPhraseAcknowledged]);

  // Leaving the screen ends this attempt. `abandon` removes the key only when
  // nothing can sign in with it, so leaving while the other screen can still
  // confirm keeps it (and onboarding resumes here).
  const abandonRef = useRef(abandon);
  useEffect(() => {
    abandonRef.current = abandon;
  }, [abandon]);
  useEffect(
    () => () => {
      aborter.current.abort();
      setLinkInProgress(false);
      if (engagedRef.current) void abandonRef.current();
    },
    [],
  );

  /** Wait for the other screen to confirm, then sign in with this key. */
  const awaitConfirmation = useCallback(
    async (linkId: string) => {
      const outcome = await awaitLinkCompletion({
        getState: () => oxyServices.identity.links.get(linkId),
        signal: aborter.current.signal,
      });
      if (outcome === 'aborted') return;
      setLinkInProgress(false);
      if (outcome !== 'completed') {
        setStep({ name: 'error', message: t('linkAccount.expired') });
        return;
      }
      await clearPendingLink();
      // The key is the account's root now: sign in with it.
      await syncIdentity();
      router.replace('/');
    },
    [oxyServices, router, syncIdentity, t],
  );

  useEffect(() => {
    if (!id || !c) return;
    let cancelled = false;
    void (async () => {
      try {
        const [state, pending] = await Promise.all([readLink(id), readPendingLink()]);
        if (cancelled) return;
        // Resumed: this phone already made a key for THIS request.
        if (pending && pending.linkId === id) {
          engagedRef.current = true;
          const verdict = pendingLinkVerdict(pending, state);
          if (verdict === 'signIn') {
            await clearPendingLink();
            await syncIdentity();
            router.replace('/');
            return;
          }
          if (verdict === 'wait') {
            setLinkInProgress(true);
            setStep({ name: 'code', code: deriveIdentityLinkCode(id, pending.publicKey) });
            await awaitConfirmation(id);
            return;
          }
        }
        setStep(
          state && state.status === 'pending' && Date.now() < state.expiresAt
            ? { name: 'confirm', username: state.username }
            : { name: 'error', message: t('linkAccount.expired') },
        );
      } catch {
        if (!cancelled) setStep({ name: 'error', message: t('linkAccount.expired') });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, c, readLink, syncIdentity, router, awaitConfirmation, t]);

  const fail = useCallback(
    (error: unknown) => {
      setLinkInProgress(false);
      const code = (error as { code?: unknown } | null)?.code;
      setStep({
        name: 'error',
        message:
          code === IDENTITY_ERROR_CODES.rootAlreadyLinked
            ? t('linkAccount.alreadyLinked')
            : t('linkAccount.failed'),
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
      await awaitConfirmation(id);
    } catch (error) {
      fail(error);
    }
  }, [id, c, oxyServices, awaitConfirmation, fail]);

  /** This phone's key, and its phrase shown before anything is linked. */
  const link = useCallback(async () => {
    setStep({ name: 'working' });
    setLinkInProgress(true);
    try {
      // A new key — or, after an earlier attempt that did not finish, the one
      // this phone already made and has not registered.
      let words: string[] | null;
      try {
        words = (await createIdentity()).recoveryPhrase;
      } catch (error) {
        if (!(error instanceof IdentityAlreadyExistsError)) throw error;
        words = (await KeyManager.getRecoveryMnemonicForCurrentIdentity())?.split(' ') ?? null;
      }
      // From here until the request completes this key is a PENDING link, not
      // an identity onboarding may register: resume comes back here.
      const publicKey = await KeyManager.getPublicKey();
      if (id && c && publicKey) {
        const pending: PendingLink = { linkId: id, challenge: c, publicKey };
        await Promise.all([persistPendingLink(pending), persistOnboardingFlow('link')]);
        engagedRef.current = true;
      }
      if (words) {
        setStep({ name: 'phrase', words });
        return;
      }
      await finish();
    } catch (error) {
      fail(error);
    }
  }, [id, c, createIdentity, finish, fail]);

  const container = [
    styles.container,
    {
      backgroundColor: colors.background,
      paddingTop: insets.top + 24,
      paddingBottom: insets.bottom + 24,
    },
  ];

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
            <Text style={[styles.text, { color: colors.text }]}>
              {t('linkAccount.confirmBody')}
            </Text>
          </View>
          <View style={styles.actions}>
            <Button
              appearance="solid"
              tone="accent"
              onPress={() => void link()}
              testID="link-account-confirm"
            >
              {t('linkAccount.confirmAction')}
            </Button>
            <Button appearance="subtle" onPress={() => router.back()}>
              {t('common.back')}
            </Button>
          </View>
        </View>
      );
    case 'code':
      return (
        <View style={container}>
          <View style={styles.body}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
              {t('linkAccount.codeTitle')}
            </Text>
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
            <Text accessibilityRole="alert" style={[styles.text, { color: colors.error }]}>
              {step.message}
            </Text>
          </View>
          <View style={styles.actions}>
            <Button
              appearance="solid"
              tone="accent"
              onPress={() => router.replace('/(auth)/link-account/scan')}
            >
              {t('linkAccount.scanAgain')}
            </Button>
            <Button
              appearance="subtle"
              onPress={() => void abandon().then(() => router.replace('/(auth)/welcome'))}
            >
              {t('common.back')}
            </Button>
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
