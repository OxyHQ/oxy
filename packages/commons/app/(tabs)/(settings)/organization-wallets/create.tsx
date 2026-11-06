import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { toast } from '@oxy.so/bloom/toast';
import {
  generateOrganizationKey,
  getOrganizationPrivateKey,
  retireIdentityKey,
  storeOrganizationKey,
  type GeneratedOrganizationKey,
} from '@oxy.so/core/crypto';
import { useOxy } from '@oxy.so/services';
import { Icons } from '@/constants/icons';
import {
  Screen,
  StackHeader,
  ImportantBanner,
  LoadingState,
  STATE_MIN_HEIGHT,
} from '@/components/ui';
import { RecoveryPhraseGrid } from '@/components/identity/RecoveryPhraseGrid';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { authenticate, hasLocalConfirmation } from '@/lib/biometricAuth';
import { organizationKeyErrorKey } from '@/lib/organization-wallet';
import {
  useInvalidateOrganizationWallets,
  useOrganizationWallet,
} from '@/hooks/organization-wallet/useOrganizationWallets';

type Step = 'phrase' | 'confirm' | 'working' | 'done' | 'localPersistFailed';

/**
 * Create or replace an organization's key (ADR 0061 D4, D5, D7).
 *
 * The new key and its 24-word phrase are made HERE, before any server call,
 * and kept only in this screen's memory until the change commits: the phrase
 * shown is the key linked. The order is phrase → (replace: the warning that
 * coins stay with the current key) → device confirmation → link (the person's
 * own root, the new key and, when this phone holds it, the current key sign one
 * challenge) → keep it on this phone. Leaving before the confirmation changes
 * nothing.
 */
export default function CreateOrganizationKeyScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const params = useLocalSearchParams<{ accountId: string; operation?: string }>();
  const accountId = params.accountId ?? null;
  const operation = params.operation === 'replace' ? 'replace' : 'create';
  const wallet = useOrganizationWallet(accountId);
  const invalidate = useInvalidateOrganizationWallets();

  const keyRef = useRef<GeneratedOrganizationKey | null>(null);
  const [words, setWords] = useState<string[] | null>(null);
  const [deriveError, setDeriveError] = useState(false);
  const [deriveNonce, setDeriveNonce] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [fundsMoved, setFundsMoved] = useState(false);
  const [step, setStep] = useState<Step>('phrase');

  useEffect(() => {
    if (keyRef.current) return;
    let active = true;
    setDeriveError(false);
    generateOrganizationKey()
      .then((key) => {
        if (!active) return;
        keyRef.current = key;
        setWords(key.mnemonic.split(' '));
      })
      .catch(() => {
        if (active) setDeriveError(true);
      });
    return () => {
      active = false;
    };
  }, [deriveNonce]);

  // Drop the key from memory when the screen goes, whatever happened.
  useEffect(
    () => () => {
      keyRef.current = null;
    },
    [],
  );

  const finish = useCallback(() => {
    router.dismissTo({
      pathname: '/(tabs)/(settings)/organization-wallets/[accountId]',
      params: { accountId: accountId ?? '' },
    });
  }, [accountId, router]);

  const commit = useCallback(async () => {
    const key = keyRef.current;
    if (!oxyServices || !accountId || !key || !wallet.data) return;
    if (await hasLocalConfirmation()) {
      const auth = await authenticate(t('organizationWallet.create.biometricReason'));
      if (!auth.success) {
        toast.error(t('organizationWallet.create.biometricFailed'));
        return;
      }
    }
    setStep('working');
    // The current key signs too when this phone holds it (recorded as proven).
    const current = wallet.data.status === 'held' ? wallet.data.deviceKey : null;
    // The key this phone holds for the organization, current or stale.
    const held = wallet.data.deviceKey;
    const heldPrivate = held ? await getOrganizationPrivateKey(accountId) : null;
    const currentPrivate = current ? heldPrivate : null;
    // Whatever key this phone holds for the organization — its current key or
    // one another owner already replaced — stays on this phone as one of its
    // previous keys, so Peable can still spend what it received (ADR 0061 D7
    // as amended; R4-12). Kept BEFORE the change: a phone that cannot keep it
    // does not replace it.
    if (held && heldPrivate) {
      try {
        await retireIdentityKey({ privateKey: heldPrivate, publicKey: held }, { accountId });
      } catch {
        toast.error(t('organizationWallet.errors.retainFailed'));
        setStep('confirm');
        return;
      }
    }
    try {
      await oxyServices.accounts.identityKey.link(accountId, {
        operation,
        key: { privateKey: key.privateKey, publicKey: key.publicKey },
        ...(current && currentPrivate
          ? { previousKey: { privateKey: currentPrivate, publicKey: current } }
          : {}),
      });
    } catch (error: unknown) {
      toast.error(t(organizationKeyErrorKey(error)));
      setStep('confirm');
      return;
    }
    try {
      await storeOrganizationKey(accountId, {
        privateKey: key.privateKey,
        publicKey: key.publicKey,
        mnemonic: key.mnemonic,
      });
      setStep('done');
    } catch {
      // The organization uses the new key; the phrase just shown is its only copy.
      setStep('localPersistFailed');
    } finally {
      keyRef.current = null;
      void invalidate();
    }
  }, [accountId, invalidate, operation, oxyServices, t, wallet.data]);

  const back = () => router.back();
  const title = t('organizationWallet.create.title');

  if (step === 'done' || step === 'localPersistFailed') {
    return (
      <Screen gap={16}>
        <StackHeader
          title={
            step === 'done'
              ? t('organizationWallet.create.doneTitle')
              : t('organizationWallet.create.localPersistTitle')
          }
        />
        <ImportantBanner type={step === 'done' ? 'info' : 'warning'}>
          {step === 'done'
            ? t('organizationWallet.create.doneBody')
            : t('organizationWallet.create.localPersistBody')}
        </ImportantBanner>
        <Button appearance="solid" tone="accent" onPress={finish}>
          {t('organizationWallet.create.done')}
        </Button>
      </Screen>
    );
  }

  if (deriveError) {
    return (
      <Screen>
        <StackHeader title={title} onBack={back} backAccessibilityLabel={t('common.back')} />
        <EmptyState
          illustration={<Icons.key size="3xl" fill={colors.error} />}
          title={t('organizationWallet.create.deriveError')}
          action={{
            label: t('organizationWallet.list.retry'),
            onPress: () => setDeriveNonce((n) => n + 1),
          }}
          minHeight={STATE_MIN_HEIGHT}
        />
      </Screen>
    );
  }

  if (!words || wallet.isPending) {
    return <LoadingState title={t('organizationWallet.create.deriving')} />;
  }

  if (step === 'phrase') {
    return (
      <Screen gap={16}>
        <StackHeader
          title={title}
          subtitle={t('organizationWallet.create.subtitle')}
          onBack={back}
          backAccessibilityLabel={t('common.back')}
        />
        <ImportantBanner title={t('organizationWallet.create.warningTitle')}>
          {t('organizationWallet.create.warning')}
        </ImportantBanner>
        {revealed ? (
          <>
            <RecoveryPhraseGrid words={words} textColor={colors.text} />
            <Button appearance="outline" onPress={() => setRevealed(false)}>
              {t('organizationWallet.phrase.hide')}
            </Button>
          </>
        ) : (
          <Button appearance="outline" onPress={() => setRevealed(true)} testID="org-key-reveal">
            {t('organizationWallet.phrase.reveal')}
          </Button>
        )}
        <Checkbox
          checked={acknowledged}
          onCheckedChange={setAcknowledged}
          disabled={!revealed && !acknowledged}
          label={t('organizationWallet.create.acknowledge')}
          accessibilityLabel={t('organizationWallet.create.acknowledge')}
        />
        <Button
          appearance="solid"
          tone="accent"
          disabled={!acknowledged}
          onPress={() => setStep('confirm')}
          testID="org-key-continue"
        >
          {t('organizationWallet.create.continue')}
        </Button>
      </Screen>
    );
  }

  const working = step === 'working';
  const ready = operation === 'create' || fundsMoved;
  return (
    <Screen gap={16}>
      <StackHeader
        title={title}
        onBack={working ? undefined : () => setStep('phrase')}
        backAccessibilityLabel={t('common.back')}
      />
      {operation === 'replace' ? (
        <>
          <ImportantBanner title={t('organizationWallet.create.replaceWarningTitle')}>
            {t('organizationWallet.create.replaceWarning')}
          </ImportantBanner>
          <Checkbox
            checked={fundsMoved}
            onCheckedChange={setFundsMoved}
            disabled={working}
            label={t('organizationWallet.create.replaceConfirm')}
            accessibilityLabel={t('organizationWallet.create.replaceConfirm')}
          />
        </>
      ) : null}
      <Button
        appearance="solid"
        tone="accent"
        onPress={() => void commit()}
        loading={working}
        disabled={working || !ready}
        testID="org-key-commit"
      >
        {working
          ? t('organizationWallet.create.working')
          : operation === 'replace'
            ? t('organizationWallet.create.confirmReplace')
            : t('organizationWallet.create.confirmCreate')}
      </Button>
    </Screen>
  );
}
