import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, Platform, AccessibilityInfo } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter } from 'expo-router';
import { useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import {
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useOxy, useCurrentUser } from '@oxyhq/services';
import { buildUserDid } from '@oxyhq/core';
import { Fab } from '@oxyhq/bloom/fab';
import { useTabBarFootprint } from '@oxyhq/bloom/tab-bar';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { Screen, Section, Callout } from '@/components/ui';
import { Ticket as OxyID } from '@/components/OxyID';
import { FrontSide } from '@/components/OxyID/front-side';
import { BackSide } from '@/components/OxyID/back-side';
import { IdQrBack } from '@/components/civic/IdQrBack';
import { AttestQrSheet } from '@/components/civic/AttestQrSheet';
import { CameraPermissionSheet } from '@/components/civic/CameraPermissionSheet';
import { useIdentity } from '@/hooks/useIdentity';
import { useAvatarUrl } from '@/hooks/useAvatarUrl';
import { useCivicProfileState } from '@/hooks/useCivicProfileState';
import { useAttestedEvent, type AttestedEventPayload } from '@/hooks/civic/useAttestedEvent';
import { getDisplayName } from '@/utils/date-utils';
import { useTranslation } from '@/lib/i18n';

const CARD_WIDTH = 240;
const CARD_HEIGHT = 380;

/**
 * The Oxy ID screen — the landing/home surface of Commons.
 *
 * It is BOTH the identity overview (formerly the Home tab) and the citizen ID
 * card, merged into one coherent screen:
 *
 *   - The hero is the flippable OxyID card. The FRONT reuses the holographic
 *     identity card (name, @username, public-key ID, trust-tier badge); the BACK
 *     renders a QR of `oxyServices.getMyIdPayload()` — the DID-only payload a
 *     counterpart scans to resolve and verify the signed card server-side.
 *   - Below the card: the self-custody identity actions (deep-linking into the
 *     Settings "about your identity" detail), the real-life attestation entry,
 *     and the raw DID.
 *   - A Bloom FAB (bottom-right) checks camera access in a detached permission
 *     sheet over this screen, then opens the root full-screen scanner only after
 *     access is granted.
 *
 * No in-screen title/subtitle/status chip: the tab bar already labels this "ID"
 * and the card stands on its own. The single accent moment is the card itself;
 * everything below it is flat, hairline-separated rows.
 *
 * Offline-first: the card front (identity + key + QR) is ALWAYS rendered from
 * the LOCAL identity and never gated on the network. The live trust tier is
 * hydrated cache-first from the signed public card.
 */
export default function IdScreen() {
  const colors = useColors();
  const router = useRouter();
  const tabBarFootprint = useTabBarFootprint();
  const { t } = useTranslation();
  const { user, oxyServices } = useOxy();
  const [cameraPermission, requestCameraPermission, refreshCameraPermission] = useCameraPermissions();
  // Hydrate the user record (createdAt + fields missing from a cached signIn).
  useCurrentUser();
  const { getPublicKey, identitySyncState } = useIdentity();

  // Drives cache-first vs live data for the card and the `pending` (not yet
  // server-registered) case. The visible status chip was intentionally dropped;
  // the hook stays wired because `state` still gates the pending note below.
  const { state } = useCivicProfileState({
    subject: 'self',
    isSynced: identitySyncState.isSynced,
  });

  const displayName = getDisplayName(user);
  const avatarUrl = useAvatarUrl(user);

  // The public key lives in local secure storage — load it directly so the card
  // renders without waiting on any network call.
  const [publicKey, setPublicKey] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getPublicKey()
      .then((pk) => {
        if (!cancelled) setPublicKey(pk);
      })
      .catch((error) => {
        console.error('[IdScreen] Failed to load public key', error);
      });
    return () => {
      cancelled = true;
    };
  }, [getPublicKey]);

  const userId = user?.id ?? oxyServices?.getCurrentUserId() ?? null;
  const did = useMemo(() => (userId ? buildUserDid(userId) : null), [userId]);

  // The Oxy ID QR payload (DID-only). Requires an authenticated session; guarded
  // so a transient "no user id" never throws through render.
  const qrPayload = useMemo(() => {
    if (!oxyServices) return null;
    try {
      return oxyServices.getMyIdPayload();
    } catch {
      return null;
    }
  }, [oxyServices, userId]);

  // ---- Attestation-confirmed card feedback --------------------------------
  const attestGlow = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  const [attestedVisible, setAttestedVisible] = useState(false);
  const attestedBadgeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (attestedBadgeTimeoutRef.current) clearTimeout(attestedBadgeTimeoutRef.current);
    };
  }, []);
  const triggerAttestGlow = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setAttestedVisible(true);
    AccessibilityInfo.announceForAccessibility(t('civic.attest.confirmed'));
    if (attestedBadgeTimeoutRef.current) clearTimeout(attestedBadgeTimeoutRef.current);
    attestedBadgeTimeoutRef.current = setTimeout(() => setAttestedVisible(false), 2500);
    if (reducedMotion) return;
    attestGlow.value = withSequence(
      withTiming(1, { duration: 400 }),
      withDelay(1000, withTiming(0, { duration: 1400 })),
    );
  }, [attestGlow, reducedMotion, t]);

  const handleAttestedEvent = useCallback(
    (payload: AttestedEventPayload) => {
      // A confirmation is only ever displayed for the identity currently on
      // screen — ignore events for another account signed in on this device.
      if (!userId || payload.subjectUserId !== userId) return;
      triggerAttestGlow();
    },
    [userId, triggerAttestGlow],
  );

  useAttestedEvent(handleAttestedEvent);

  const publicKeyShort = useMemo(() => {
    if (!publicKey) return undefined;
    if (publicKey.length <= 16) return publicKey;
    return `${publicKey.substring(0, 8)}...${publicKey.substring(publicKey.length - 8)}`;
  }, [publicKey]);

  const [cameraPermissionSheetOpen, setCameraPermissionSheetOpen] = useState(false);

  const openScanner = useCallback(() => {
    router.push('/(scan)');
  }, [router]);

  const handleScan = useCallback(() => {
    if (cameraPermission?.granted) {
      openScanner();
      return;
    }
    setCameraPermissionSheetOpen(true);
  }, [cameraPermission?.granted, openScanner]);

  const handleCameraPermissionGranted = useCallback(() => {
    setCameraPermissionSheetOpen(false);
    openScanner();
  }, [openScanner]);

  // Show A's fresh attestation QR as a bottom sheet (over the ID tab) instead of
  // pushing a dedicated screen — a counterparty scans it to confirm they met A.
  const [qrSheetOpen, setQrSheetOpen] = useState(false);
  const handleGetVerified = useCallback(() => setQrSheetOpen(true), []);

  const handleAboutIdentity = useCallback(() => {
    router.push('/(tabs)/(settings)/about-identity');
  }, [router]);

  const isNative = Platform.OS !== 'web';

  return (
    <View style={styles.screen}>
      {/* Flush column — Bloom's SettingsListGroup owns its horizontal gutter; the
          centered hero and the DID/callout blocks are padded to align with it. */}
      <Screen contentStyle={styles.flush} gap={16}>
        <View style={styles.hero}>
          <OxyID
            width={CARD_WIDTH}
            height={CARD_HEIGHT}
            attestGlow={attestGlow}
            frontSide={
              <FrontSide
                displayName={displayName}
                username={user?.username}
                avatarUrl={avatarUrl}
                accountCreated={user?.createdAt}
                publicKeyShort={publicKeyShort}
              />
            }
            backSide={
              <BackSide
                publicKey={publicKey ?? undefined}
                displayName={displayName}
                accountCreated={user?.createdAt}
              />
            }
            qrSide={
              qrPayload ? (
                <IdQrBack payload={qrPayload} caption={t('civic.id.qrCaption')} />
              ) : (
                <View style={styles.qrPlaceholder}>
                  <ThemedText style={styles.qrPlaceholderText}>{t('civic.id.qrPending')}</ThemedText>
                </View>
              )
            }
          />
          {attestedVisible && (
            <View style={[styles.attestedBadge, { backgroundColor: colors.card }]}>
              <MaterialCommunityIcons name="check-decagram" size={18} color={colors.success} />
              <ThemedText style={styles.attestedBadgeText}>{t('civic.attest.confirmed')}</ThemedText>
            </View>
          )}
          <ThemedText style={[styles.flipHint, { color: colors.textSecondary }]}>
            {t('civic.id.flipHint')}
          </ThemedText>
        </View>

        {/* Self-custody identity actions (native only). */}
        {isNative && (
          <SettingsListGroup
            title={t('vault.home.yourIdentity')}
            footer={t('vault.home.yourIdentitySubtitle')}
          >
            <SettingsListItem
              icon={<MaterialCommunityIcons name="shield-key" size={22} color={colors.text} />}
              title={t('home.identity.selfCustody')}
              description={t('home.identity.selfCustodySubtitle')}
              onPress={handleAboutIdentity}
            />
            <SettingsListItem
              icon={<MaterialCommunityIcons name="key-variant" size={22} color={colors.text} />}
              title={t('home.identity.publicKey')}
              description={t('home.identity.publicKeySubtitle')}
              onPress={handleAboutIdentity}
            />
          </SettingsListGroup>
        )}

        {/* Real-life attestation — A shows a QR for B to confirm they met IRL */}
        <SettingsListGroup
          title={t('civic.attest.section.title')}
          footer={t('civic.attest.section.subtitle')}
        >
          <SettingsListItem
            icon={<MaterialCommunityIcons name="handshake-outline" size={22} color={colors.text} />}
            title={t('civic.attest.section.action')}
            description={t('civic.attest.section.actionSubtitle')}
            onPress={handleGetVerified}
          />
        </SettingsListGroup>

        {did && (
          <View style={styles.gutter}>
            <Section title={t('civic.id.didLabel')}>
              <ThemedText style={[styles.didValue, { color: colors.textSecondary }]} selectable numberOfLines={2}>
                {did}
              </ThemedText>
            </Section>
          </View>
        )}

        {state === 'pending' && (
          <View style={styles.gutter}>
            <Callout tone="warning" icon="clock-outline">
              {t('civic.id.pendingNote')}
            </Callout>
          </View>
        )}
      </Screen>

      {/*
        QR scanner is an action, not a tab. Camera permission is resolved in a
        detached sheet over this ID screen before the root scanner modal opens.

        `offset` lifts the FAB clear of the floating tab bar. It is the bar's RAW
        footprint: `Fab` supplies its own gap from that anchor, and the bottom
        safe-area inset is already folded into the footprint, so adding
        `insets.bottom` here would count the home indicator twice.
      */}
      <Fab
        variant="primary"
        placement="bottom-right"
        offset={tabBarFootprint}
        onPress={handleScan}
        accessibilityLabel={t('civic.id.scanAction')}
        icon={<MaterialCommunityIcons name="qrcode-scan" size={26} color={colors.primaryForeground} />}
      />

      {qrSheetOpen && <AttestQrSheet onClose={() => setQrSheetOpen(false)} />}
      {cameraPermissionSheetOpen && (
        <CameraPermissionSheet
          requestPermission={requestCameraPermission}
          refreshPermission={refreshCameraPermission}
          onGranted={handleCameraPermissionGranted}
          onClose={() => setCameraPermissionSheetOpen(false)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  flush: { paddingHorizontal: 0 },
  gutter: { paddingHorizontal: 20 },
  hero: {
    alignItems: 'center',
    gap: 16,
    paddingTop: 8,
  },
  qrPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  qrPlaceholderText: {
    fontSize: 13,
    color: '#3A3A3C',
    textAlign: 'center',
  },
  flipHint: {
    fontSize: 13,
    textAlign: 'center',
  },
  attestedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderCurve: 'continuous',
  },
  attestedBadgeText: {
    fontSize: 13,
    fontWeight: '600',
  },
  didValue: {
    fontSize: 13,
    lineHeight: 19,
  },
});
