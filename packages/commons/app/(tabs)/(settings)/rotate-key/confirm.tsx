import React, { useCallback, useEffect, useState } from 'react';
import { Admonition } from '@oxy.so/bloom/admonition';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Checkbox } from 'expo-checkbox';
import { Icons } from '@/constants/icons';
import { useOxy } from '@oxy.so/services';
import { toast } from '@oxy.so/bloom/toast';
import { useColors } from '@/hooks/useColors';
import { Button } from '@oxy.so/bloom/button';
import {
  Screen,
  StackHeader,
  ImportantBanner,
} from '@/components/ui';
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
 * `localPersistFailed` is NOT a failure: the server rotated and the user already
 * saw the new phrase, but the new key couldn't be written to this device. We
 * guide the user to restore it from that phrase rather than showing an error.
 */
export default function RotateKeyConfirmScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const { proof, currentPhraseRef, pendingIdentityRef, reset } = useRotateKeyFlow();

  const [state, setState] = useState<ConfirmState>('form');
  const [signOutEverywhere, setSignOutEverywhere] = useState(false);

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
    if (!pending) return;

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
        phrase: proof === 'phrase' ? currentPhraseRef.current ?? undefined : undefined,
        signOutEverywhere,
        pendingIdentity: pending,
      });

      // The new key material has served its purpose — scrub the in-memory copies.
      currentPhraseRef.current = null;
      pendingIdentityRef.current = null;

      if (result.localPersistFailed) {
        // Server rotated, phrase already shown — guide to restore, don't error.
        setState('localPersistFailed');
        return;
      }

      toast.success(t('rotateKey.confirm.successBody'));
      setState('success');
    } catch (err: unknown) {
      toast.error(extractAuthErrorMessage(err, t('rotateKey.confirm.errorGeneric')));
      setState('form');
    }
  }, [oxyServices, proof, currentPhraseRef, pendingIdentityRef, signOutEverywhere, t]);

  if (!flowReady && state === 'form') {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }

  if (state === 'success') {
    return (
      <Screen>
        <StackHeader title={t('rotateKey.confirm.successTitle')} />
        <Admonition type="info">
          {t('rotateKey.confirm.successBody')}
        </Admonition>
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

      <TouchableOpacity
        style={[styles.toggleRow, { backgroundColor: colors.card, borderColor: colors.border }]}
        onPress={() => setSignOutEverywhere((v) => !v)}
        activeOpacity={0.7}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: signOutEverywhere }}
        accessibilityLabel={t('rotateKey.confirm.signOutEverywhere')}
        disabled={rotating}
      >
        <Icons.signOut size='md' fill={colors.textSecondary} />
        <View className="flex-1 gap-space-2">
          <Text style={[styles.toggleTitle, { color: colors.text }]}>
            {t('rotateKey.confirm.signOutEverywhere')}
          </Text>
          <Text style={[styles.toggleHint, { color: colors.textSecondary }]}>
            {t('rotateKey.confirm.signOutEverywhereHint')}
          </Text>
        </View>
        <Checkbox
          value={signOutEverywhere}
          onValueChange={setSignOutEverywhere}
          color={signOutEverywhere ? colors.tint : undefined}
          disabled={rotating}
        />
      </TouchableOpacity>

      <Button appearance="solid" tone="accent" onPress={handleRotate} loading={rotating} disabled={rotating}>{rotating ? t('rotateKey.confirm.rotating') : t('rotateKey.confirm.cta')}</Button>
    </Screen>
  );
}

const styles = StyleSheet.create({
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderWidth: 1,
    borderRadius: 16,
    borderCurve: 'continuous',
  },
  toggleTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  toggleHint: {
    fontSize: 13,
    lineHeight: 18,
  },
});
