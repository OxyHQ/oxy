import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icons } from '@/constants/icons';
import { parseIdentityLinkQrPayload } from '@oxy.so/contracts';
import { useColors } from '@/hooks/useColors';
import { Button } from '@oxy.so/bloom/button';
import { useTranslation } from '@/lib/i18n';

/**
 * Scan the code auth.oxy.so/link-commons shows, to link that web account to
 * this phone (ADR 0029 D3).
 *
 * Lives in the `(auth)` flow, not `(scan)`: the person has no identity on this
 * device yet, and `(scan)` is only reachable once signed in. Only a link QR is
 * accepted here; it carries the request's id and the challenge Commons signs.
 */
export default function ScanLinkScreen() {
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const [invalid, setInvalid] = useState(false);

  const handleScanned = useCallback(
    ({ data }: BarcodeScanningResult) => {
      if (invalid) return;
      const link = parseIdentityLinkQrPayload(data);
      if (!link) {
        setInvalid(true);
        return;
      }
      router.replace({ pathname: '/(auth)/link-account/confirm', params: { id: link.linkId, c: link.challenge } });
    },
    [invalid, router],
  );

  if (!permission?.granted) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <Text style={[styles.title, { color: colors.text }]}>{t('linkAccount.scanTitle')}</Text>
        <Text style={[styles.body, { color: colors.text }]}>{t('linkAccount.permissionBody')}</Text>
        {permission ? (
          <Button appearance="solid" tone="accent" onPress={() => void requestPermission()} style={styles.button}>
            {t('linkAccount.grantPermission')}
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
        <Text style={styles.panelText}>{invalid ? t('linkAccount.invalidCode') : t('linkAccount.scanInstructions')}</Text>
        {invalid ? (
          <TouchableOpacity
            style={styles.control}
            onPress={() => setInvalid(false)}
            accessibilityRole="button"
            accessibilityLabel={t('linkAccount.scanAgain')}
          >
            <Icons.refresh size='xl' fill="#fff" />
            <Text style={styles.controlText}>{t('linkAccount.scanAgain')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <TouchableOpacity
        style={[styles.close, { top: insets.top + 16 }]}
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
      >
        <Icons.close size='xl' fill="#fff" />
      </TouchableOpacity>
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
  panel: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 24, paddingHorizontal: 32, backgroundColor: 'rgba(0, 0, 0, 0.6)', alignItems: 'center', gap: 16 },
  panelText: { color: '#fff', fontSize: 16, lineHeight: 22, textAlign: 'center' },
  control: { alignItems: 'center', gap: 8 },
  controlText: { color: '#fff', fontSize: 12 },
  close: { position: 'absolute', right: 20, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'center', alignItems: 'center' },
});
