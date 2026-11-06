import { useCallback, useEffect, useState } from 'react';
import { Admonition } from '@oxy.so/bloom/admonition';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Checkbox, CheckboxCard } from '@oxy.so/bloom/checkbox';
import { useOxy } from '@oxy.so/services';
import { useQueryClient } from '@tanstack/react-query';
import { BACKUP_OWED_QUERY_KEY } from '@/hooks/identity/useBackupOwed';
import { toast } from '@oxy.so/bloom/toast';
import { useColors } from '@/hooks/useColors';
import { Button } from '@oxy.so/bloom/button';
import { Screen, StackHeader, ImportantBanner } from '@/components/ui';
import { useTranslation } from '@/lib/i18n';
import { authenticate } from '@/lib/biometricAuth';
import { useRotateKeyFlow } from '@/contexts/rotate-key-flow-context';
import { extractAuthErrorMessage } from '@/utils/auth/errorUtils';

type ConfirmState = 'form' | 'rotating' | 'success' | 'localPersistFailed';

/**
 * Final rotation step. Biometric-gates the identity-key signature, then calls
 * `oxyServices.identity.rotateKey` with the pre-derived new identity so the phrase shown
 * on the previous step is exactly the one committed.
 *
 * Both proof paths end here, and neither can rotate until the person ticks the
 * funds acknowledgement: the Peable wallet is derived from the identity key
 * (`KeyManager.deriveScopedSeed`), so every coin received under the current key
 * stays spendable only with the current phrase, and after the rotation this
 * device keeps only the new key (Peable ADR 0002, the organization flow's
 * `replaceConfirm` in ADR 0061 D7).
 *
 * `localPersistFailed` is NOT a failure: the server rotated and the user already
 * saw the new phrase, but the new key couldn't be written to this device. We
 * guide the user to restore it from that phrase rather than showing an error.
 */
export default function RotateKeyConfirmScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const { proof, currentPhraseRef, pendingIdentityRef, reset } = useRotateKeyFlow();

  const [state, setState] = useState<ConfirmState>('form');
  const [signOutEverywhere, setSignOutEverywhere] = useState(false);
  const [fundsAcknowledged, setFundsAcknowledged] = useState(false);

  // Guard against a direct/refresh landing without the prerequisite flow state.
  const flowReady = !!proof && !!pendingIdentityRef.current;
  useEffect(() => {
    if (!flowReady && state === 'form') {
      router.replace('/(tabs)/(settings)/rotate-key');
    }
  }, [flowReady, state, router]);

  const finish = useCallback(() => {
    reset();
    router.dismissTo('/(tabs)/(settings)');
  }, [reset, router]);

  const handleRotate = useCallback(async () => {
    if (!oxyServices || !proof) return;
    const pending = pendingIdentityRef.current;
    if (!pending || !fundsAcknowledged) return;

    // Biometric/passcode gate BEFORE the identity-key signature.
    const auth = await authenticate(t('rotateKey.confirm.biometricReason'));
    if (!auth.success) {
      toast.error(t('rotateKey.confirm.biometricFailed'));
      return;
    }

    setState('rotating');
    try {
      const result = await oxyServices.identity.rotateKey({
        proof,
        phrase: proof === 'phrase' ? (currentPhraseRef.current ?? undefined) : undefined,
        signOutEverywhere,
        pendingIdentity: pending,
      });

      // The new key material has served its purpose — scrub the in-memory copies.
      currentPhraseRef.current = null;
      pendingIdentityRef.current = null;
      // Whether the new backup is still owed (R5-9) changed with the rotation.
      void queryClient.invalidateQueries({ queryKey: BACKUP_OWED_QUERY_KEY });

      if (result.localPersistFailed) {
        // Server rotated, phrase already shown — guide to restore, don't error.
        setState('localPersistFailed');
        return;
      }

      toast.success(t('rotateKey.confirm.successBody'));
      if (result.backupRefreshed === false) {
        // The old backup was deleted with the rotation and the new one could
        // not be sealed: the replaced key is on this phone only (R4-4).
        toast.error(t('rotateKey.confirm.backupNotRefreshed'));
      }
      setState('success');
    } catch (err: unknown) {
      toast.error(extractAuthErrorMessage(err, t('rotateKey.confirm.errorGeneric')));
      setState('form');
    }
  }, [
    oxyServices,
    proof,
    currentPhraseRef,
    pendingIdentityRef,
    signOutEverywhere,
    fundsAcknowledged,
    queryClient,
    t,
  ]);

  if (!flowReady && state === 'form') {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }

  if (state === 'success') {
    return (
      <Screen>
        <StackHeader title={t('rotateKey.confirm.successTitle')} />
        <Admonition type="info">{t('rotateKey.confirm.successBody')}</Admonition>
        <Button appearance="solid" tone="accent" onPress={finish}>
          {t('rotateKey.confirm.done')}
        </Button>
      </Screen>
    );
  }

  if (state === 'localPersistFailed') {
    return (
      <Screen>
        <StackHeader title={t('rotateKey.confirm.localPersistTitle')} />
        <ImportantBanner title={t('rotateKey.confirm.localPersistTitle')}>
          {t('rotateKey.confirm.localPersistBody')}
        </ImportantBanner>
        <Button appearance="solid" tone="accent" onPress={finish}>
          {t('rotateKey.confirm.done')}
        </Button>
      </Screen>
    );
  }

  const rotating = state === 'rotating';

  return (
    <Screen>
      <StackHeader
        title={t('rotateKey.confirm.title')}
        subtitle={t('rotateKey.confirm.subtitle')}
        onBack={rotating ? undefined : () => router.back()}
        backAccessibilityLabel={t('common.back')}
      />

      <Admonition type="info">
        {proof === 'phrase'
          ? t('rotateKey.confirm.summaryPhrase')
          : t('rotateKey.confirm.summaryDevice')}
      </Admonition>

      <ImportantBanner title={t('rotateKey.confirm.fundsTitle')}>
        {t('rotateKey.confirm.fundsBody')}
      </ImportantBanner>

      <Checkbox
        checked={fundsAcknowledged}
        onCheckedChange={setFundsAcknowledged}
        disabled={rotating}
        label={t('rotateKey.confirm.fundsConfirm')}
        accessibilityLabel={t('rotateKey.confirm.fundsConfirm')}
        testID="rotate-key-funds-ack"
      />

      <CheckboxCard
        title={t('rotateKey.confirm.signOutEverywhere')}
        description={t('rotateKey.confirm.signOutEverywhereHint')}
        checked={signOutEverywhere}
        onCheckedChange={setSignOutEverywhere}
        disabled={rotating}
        accessibilityLabel={t('rotateKey.confirm.signOutEverywhere')}
      />

      <Button
        appearance="solid"
        tone="accent"
        onPress={handleRotate}
        loading={rotating}
        disabled={rotating || !fundsAcknowledged}
        testID="rotate-key-commit"
      >
        {rotating ? t('rotateKey.confirm.rotating') : t('rotateKey.confirm.cta')}
      </Button>
    </Screen>
  );
}
