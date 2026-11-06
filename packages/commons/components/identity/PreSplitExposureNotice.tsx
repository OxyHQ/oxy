import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { KeyManager, getPreSplitExposure } from '@oxy.so/core/crypto';
import { ImportantBanner } from '@/components/ui/important-banner';
import { useTranslation } from '@/lib/i18n';

/**
 * iOS: the identity on this iPhone was created before the keychain split
 * (ADR 0062), when every Oxy iOS app could read it. The access-group migration
 * records that (`getPreSplitExposure`); while that key is still the current
 * one, Settings RECOMMENDS a rotation. Nothing is forced: there is no sign the
 * key was misused, and rotating keeps the old key for spending (ADR 0061 D7).
 * Renders nothing anywhere else.
 */
export function PreSplitExposureNotice() {
  const router = useRouter();
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const exposure = await getPreSplitExposure();
      if (!exposure?.publicKey) return;
      const current = await KeyManager.getPublicKey().catch(() => null);
      if (alive && current && KeyManager.canonicalPublicKey(current) === exposure.publicKey) {
        setVisible(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!visible) return null;
  return (
    <View style={styles.block} testID="pre-split-exposure-notice">
      <ImportantBanner title={t('security.preSplitExposureTitle')}>
        {t('security.preSplitExposureBody')}
      </ImportantBanner>
      <Button
        appearance="solid"
        tone="accent"
        onPress={() => router.push('/(tabs)/(settings)/rotate-key')}
      >
        {t('security.preSplitExposureAction')}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 12 },
});
