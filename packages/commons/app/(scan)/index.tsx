import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useFocusEffect, useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { parseScan, type ScanResult } from '@/lib/commons-signin/parse-scan';
import { useAttestFlow } from '@/hooks/civic/useAttestFlow';
import { AttestReviewSheet, type AttestReviewStatus } from '@/components/civic/AttestReviewSheet';
import { authenticate, canUseBiometrics, getErrorMessage } from '@/lib/biometricAuth';

/**
 * QR scanner for the Commons handoffs (approver / verifier side).
 *
 * `parseScan` branches the scanned string into one of three Commons payloads:
 *   - a "Sign in with Oxy" approval (`oxycommons://approve?code=…`) → the
 *     `/approve` flow, which re-resolves the requesting app identity server-side
 *   - a citizen Oxy ID card (`oxycommons://card?did=…`) → the `(id)/card` view,
 *     which resolves and verifies the signed card server-side
 *   - a real-life attestation (`oxycommons://attest?…`) → held for review in
 *     `AttestReviewSheet`; B confirms + passes biometrics before signing
 *
 * The QR is never trusted for display — only the opaque `code` / `did` it
 * carries is used, and both are re-resolved server-side.
 */
export default function ScanSignInScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const [permission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [flashOn, setFlashOn] = useState(false);
  const [scanError, setScanError] = useState<'invalid' | 'expired' | null>(null);
  const attest = useAttestFlow();
  // True while B's device biometric gate is running (before the signed submit).
  const [confirming, setConfirming] = useState(false);

  // Each time the scanner gains focus, start a fresh session: clear any stale
  // attest outcome from an earlier scan and reset local UI state so a leftover
  // confirmation sheet or frozen camera can't leak across opens (the modal may
  // stay mounted after `router.back()`).
  const resetScannerSession = useCallback(() => {
    attest.reset();
    setScanned(false);
    setScanError(null);
    setConfirming(false);
    setFlashOn(false);
  }, [attest.reset]);

  useFocusEffect(resetScannerSession);

  // Shared routing for anything `parseScan` can resolve.
  const routeParsed = useCallback(
    (parsed: ScanResult) => {
      // `replace` so the hardware back button doesn't return to the camera.
      if (parsed.kind === 'approval') {
        // Approval lives at the ROOT (`/approve`, a transparentModal) — NOT in
        // this `(scan)` fullScreenModal group — so the sheet rises over the real
        // context (the `(tabs)` anchor) instead of an opaque group card.
        // `replace` from the camera dismisses this modal and presents `/approve`.
        // `source: 'scanner'` marks the cross-device QR path so approval stays in
        // Commons on success (an external deep link omits it and, on Android,
        // returns to the caller instead).
        router.replace({ pathname: '/approve', params: { code: parsed.code, source: 'scanner' } });
        return;
      }
      if (parsed.kind === 'id') {
        router.replace({ pathname: '/(tabs)/(id)/card/[did]', params: { did: parsed.did } });
        return;
      }
      if (parsed.kind === 'attest') {
        // Real-life attestation: HOLD the parsed payload and resolve A's card so
        // B can review who they're vouching for BEFORE anything is signed (the
        // review sheet). Nothing is submitted until B confirms + passes biometrics.
        setScanned(true); // freeze the camera behind the sheet
        attest.prepare({
          subjectDid: parsed.subjectDid,
          context: parsed.context,
          nonce: parsed.nonce,
          exp: parsed.exp,
        });
        return;
      }
      // Freeze the camera behind the error overlay (idempotent — the barcode
      // handler already set `scanned`) so "Scan Again" always resets from the
      // same state, whichever branch routed here.
      setScanned(true);
      setScanError(parsed.reason);
    },
    [router, attest.prepare],
  );

  const handleBarcodeScanned = useCallback(
    ({ data }: BarcodeScanningResult) => {
      if (scanned) return;
      setScanned(true);
      routeParsed(parseScan(data));
    },
    [scanned, routeParsed],
  );

  const handleScanAgain = useCallback(() => {
    attest.reset();
    setScanError(null);
    setScanned(false);
  }, [attest.reset]);

  // B tapped "Confirm we met" — run the device biometric gate, then sign +
  // submit. A failed/cancelled gate leaves the review sheet open to retry.
  const handleConfirmAttest = useCallback(async () => {
    setConfirming(true);
    try {
      const canUse = await canUseBiometrics();
      if (canUse) {
        const auth = await authenticate(t('civic.attest.review.biometricReason'));
        if (!auth.success) {
          setScanError(null);
          console.warn('[scan] attest biometric gate not passed', getErrorMessage(auth.error));
          return;
        }
      }
      attest.confirm(canUse);
    } finally {
      setConfirming(false);
    }
  }, [attest.confirm, t]);

  // Dismiss the review sheet (cancel / done / error) → reset and resume scanning.
  const handleSheetClose = useCallback(() => {
    attest.reset();
    setScanned(false);
  }, [attest.reset]);

  const handleClose = useCallback(() => {
    // Leaving the scanner ends the current attest flow; an in-flight submit is
    // simply abandoned (the store ignores its late completion).
    attest.reset();
    if (router.canGoBack()) {
      // Dismiss the scanner modal back to whatever presented it (the ID tab).
      router.back();
    } else {
      // No history (e.g. cold deep link) — land on the ID home, not the camera.
      router.replace('/(tabs)/(id)');
    }
  }, [attest.reset, router]);

  // The in-app entry point owns the detached permission sheet and only pushes
  // this full-screen route after access is granted. If a stale/direct route
  // reaches the scanner without permission, bounce back instead of presenting
  // another permission surface over an empty scanner modal.
  useEffect(() => {
    if (permission && !permission.granted) handleClose();
  }, [handleClose, permission]);

  const toggleFlash = useCallback(() => setFlashOn((prev) => !prev), []);

  // Permission not determined yet
  if (!permission) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.text, { color: colors.text }]}>
          {t('signInApproval.scan.requestingPermission')}
        </Text>
      </View>
    );
  }

  // Permission denied
  if (!permission.granted) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.text, { color: colors.text }]}>
          {t('signInApproval.scan.requestingPermission')}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        facing="back"
        enableTorch={flashOn}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
      >
        <View style={styles.overlay}>
          <View style={styles.overlaySection} />
          <View style={styles.middleSection}>
            <View style={styles.overlaySection} />
            <View style={styles.scannerFrame}>
              <View style={[styles.corner, styles.cornerTopLeft]} />
              <View style={[styles.corner, styles.cornerTopRight]} />
              <View style={[styles.corner, styles.cornerBottomLeft]} />
              <View style={[styles.corner, styles.cornerBottomRight]} />
            </View>
            <View style={styles.overlaySection} />
          </View>
          <View style={[styles.overlaySection, styles.bottomSection]}>
            {scanError ? (
              <>
                <Text style={styles.errorText}>
                  {scanError === 'expired'
                    ? t('signInApproval.scan.expiredBody')
                    : t('signInApproval.scan.invalidBody')}
                </Text>
                <TouchableOpacity
                  style={styles.controlButton}
                  onPress={handleScanAgain}
                  accessibilityRole="button"
                  accessibilityLabel={t('signInApproval.scan.a11y.scanAgain')}
                >
                  <MaterialCommunityIcons name="refresh" size={28} color="#fff" />
                  <Text style={styles.controlText}>{t('signInApproval.scan.scanAgain')}</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.instructionText}>{t('signInApproval.scan.instructions')}</Text>
                <TouchableOpacity
                  style={styles.controlButton}
                  onPress={toggleFlash}
                  accessibilityRole="button"
                  accessibilityLabel={
                    flashOn ? t('signInApproval.scan.a11y.flashOff') : t('signInApproval.scan.a11y.flashOn')
                  }
                  accessibilityState={{ selected: flashOn }}
                >
                  <MaterialCommunityIcons name={flashOn ? 'flash' : 'flash-off'} size={28} color="#fff" />
                  <Text style={styles.controlText}>
                    {flashOn ? t('signInApproval.scan.flashOn') : t('signInApproval.scan.flashOff')}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>

        <TouchableOpacity
          style={styles.closeButton}
          onPress={handleClose}
          accessibilityRole="button"
          accessibilityLabel={t('signInApproval.scan.a11y.close')}
        >
          <MaterialCommunityIcons name="close" size={28} color="#fff" />
        </TouchableOpacity>
      </CameraView>

      {attest.status !== 'idle' ? (
        <AttestReviewSheet
          status={attest.status as AttestReviewStatus}
          card={attest.subject?.card ?? null}
          verified={attest.subject?.verified ?? false}
          subjectFailed={attest.subjectFailed}
          result={attest.result}
          errorCode={attest.errorCode}
          onConfirm={handleConfirmAttest}
          confirming={confirming}
          onClose={handleSheetClose}
        />
      ) : null}
    </View>
  );
}

const SCANNER_SIZE = 280;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  centered: {
    padding: 32,
  },
  camera: {
    flex: 1,
    width: '100%',
  },
  overlay: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  overlaySection: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  middleSection: {
    flexDirection: 'row',
    height: SCANNER_SIZE,
  },
  scannerFrame: {
    width: SCANNER_SIZE,
    height: SCANNER_SIZE,
    backgroundColor: 'transparent',
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderColor: '#fff',
  },
  cornerTopLeft: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 12 },
  cornerTopRight: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 12 },
  cornerBottomLeft: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 12 },
  cornerBottomRight: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 12 },
  bottomSection: {
    justifyContent: 'flex-start',
    alignItems: 'center',
    paddingTop: 32,
  },
  instructionText: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
    paddingHorizontal: 32,
    marginBottom: 24,
  },
  errorText: {
    color: '#fff',
    fontSize: 15,
    textAlign: 'center',
    paddingHorizontal: 32,
    marginBottom: 24,
  },
  controlButton: {
    alignItems: 'center',
    gap: 8,
  },
  controlText: {
    color: '#fff',
    fontSize: 12,
  },
  closeButton: {
    position: 'absolute',
    top: 60,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  text: {
    fontSize: 16,
  },
});
