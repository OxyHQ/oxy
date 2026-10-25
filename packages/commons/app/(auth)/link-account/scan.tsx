import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icons } from '@/constants/icons';
import { parseIdentityLinkQrPayload } from '@oxy.so/contracts/client';
import { useColors } from '@/hooks/useColors';
import { Button } from '@oxy.so/bloom/button';
import { FrostedIconButton } from '@oxy.so/bloom/frosted-icon-button';
import { useTranslation } from '@/lib/i18n';

/**
 * Scan the code Security > Link Commons shows, to link that web account to
 * this phone (ADR 0029 D3).
 *
 * Lives in the `(auth)` flow, not `(scan)`: the person has no identity on this
 * device yet, and `(scan)` is only reachable once signed in. Only a link QR is
 * accepted here; it carries the request's id and the challenge Commons signs.
 *
 * A camera permission the person refused for good (`canAskAgain: false`) can
 * only be changed in the system settings: the screen then says so and opens
 * them, and re-reads the permission when Commons comes back to the foreground.
 */
export default function ScanLinkScreen() {
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [invalid, setInvalid] = useState(false);

  // The system settings do not update Expo's permission hook by themselves.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void getPermission();
    });
    return () => subscription.remove();
  }, [getPermission]);

  const blocked = Boolean(permission && !permission.granted && !permission.canAskAgain);
  const openSettings = useCallback(() => {
    void (Platform.OS === 'ios' ? Linking.openURL('app-settings:') : Linking.openSettings()).catch(
      () => undefined,
    );
  }, []);

  const handleScanned = useCallback(
    ({ data }: BarcodeScanningResult) => {
      if (invalid) return;
      const link = parseIdentityLinkQrPayload(data);
      if (!link) {
        setInvalid(true);
        return;
      }
      router.replace({
        pathname: '/(auth)/link-account/confirm',
        params: { id: link.linkId, c: link.challenge },
      });
    },
    [invalid, router],
  );

  if (!permission?.granted) {
    return (
      <View
        style={[styles.centered, { backgroundColor: colors.background, paddingTop: insets.top }]}
      >
        <Text style={[styles.title, { color: colors.text }]}>{t('linkAccount.scanTitle')}</Text>
        <Text style={[styles.body, { color: colors.text }]}>
          {blocked ? t('linkAccount.permissionBlockedBody') : t('linkAccount.permissionBody')}
        </Text>
        {permission ? (
          <Button
            appearance="solid"
            tone="accent"
            onPress={blocked ? openSettings : () => void requestPermission()}
            style={styles.button}
            testID={blocked ? 'link-account-open-settings' : 'link-account-grant-camera'}
          >
            {blocked ? t('linkAccount.openSettings') : t('linkAccount.grantPermission')}
          </Button>
        ) : null}
        <Button appearance="subtle" onPress={() => router.back()}>
          {t('common.back')}
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={invalid ? undefined : handleScanned}
      />
      <View style={[styles.panel, { paddingBottom: insets.bottom + 24 }]}>
        <Text style={styles.panelText}>
          {invalid ? t('linkAccount.invalidCode') : t('linkAccount.scanInstructions')}
        </Text>
        {invalid ? (
          <Button
            appearance="outline"
            tone="neutral"
            leadingIcon={Icons.refresh}
            onPress={() => setInvalid(false)}
          >
            {t('linkAccount.scanAgain')}
          </Button>
        ) : null}
      </View>
      <FrostedIconButton
        icon={Icons.close}
        onPress={() => router.back()}
        accessibilityLabel={t('common.close')}
        style={[styles.close, { top: insets.top + 16 }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', padding: 24 },
  title: { fontSize: 28, fontWeight: '600', textAlign: 'center', marginBottom: 12 },
  body: { fontSize: 16, lineHeight: 22, textAlign: 'center', opacity: 0.7 },
  button: { marginTop: 32 },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 24,
    paddingHorizontal: 32,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    alignItems: 'center',
    gap: 16,
  },
  panelText: { color: '#fff', fontSize: 16, lineHeight: 22, textAlign: 'center' },
  close: { position: 'absolute', right: 20 },
});
