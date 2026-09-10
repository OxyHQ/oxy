import React, { useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import type { VerifiableCredentialResponse, CredentialStatus } from '@oxy.so/contracts';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { Screen, StackHeader, Section, GroupedList, CenteredState, SessionGate } from '@/components/ui';
import { CivicBadge } from '@/components/civic/CivicBadge';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { useMyCredentials } from '@/hooks/useCredentials';
import { useCivicProfileState } from '@/hooks/useCivicProfileState';
import {
  primaryCredentialType,
  humanizeTypeTag,
  claimEntries,
  getCredentialStatusMeta,
} from '@/lib/civic/credential-display';
import { userIdFromDid } from '@/lib/civic/did';
import { formatDate } from '@/utils/date-utils';
import { shortenKey } from '@/utils/shorten-key';
import { useTranslation } from '@/lib/i18n';
import type { MaterialCommunityIconName } from '@/types/icons';

/** Icon per credential status (active = sealed, revoked = struck out, expired = lapsed). */
const STATUS_ICON: Record<CredentialStatus, MaterialCommunityIconName> = {
  active: 'certificate-outline',
  revoked: 'close-octagon-outline',
  expired: 'clock-alert-outline',
};

/** Format an epoch-ms timestamp to a short readable date (or empty). */
function formatMs(ms: number | undefined): string {
  return ms != null ? formatDate(new Date(ms).toISOString()) : '';
}

/**
 * "My credentials" — the verifiable credentials the current user holds.
 *
 * Reads the holder list via `listMyCredentials()` (offline-first, like the other
 * civic surfaces). Each credential is a flat, hairline-separated row: the
 * specific type, a preview of the signed claims, a compact issuer reference + the
 * issued date, and a status pill (active / revoked / expired). Tapping a row
 * opens its detail + verify screen. Loading / empty / error states are all
 * handled; pull-to-refresh re-reads.
 */
export default function CredentialsScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();

  const query = useMyCredentials();
  const credentials = query.data?.credentials;
  const { isOnline } = useCivicProfileState({ subject: 'remote' });

  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/(settings)');
  }, [router]);

  const openDetail = useCallback(
    (recordId: string) => {
      router.push({
        pathname: '/(tabs)/(settings)/credentials/[recordId]',
        params: { recordId },
      });
    },
    [router],
  );

  const renderBody = () => {
    if (query.isPending && !credentials) {
      return <CenteredState loading body={t('civic.credentials.loading')} />;
    }

    if (query.isError && !credentials) {
      return (
        <CenteredState
          icon="cloud-alert"
          title={t('civic.credentials.error.title')}
          body={t('civic.credentials.error.body')}
          action={
            <TouchableOpacity
              style={[styles.retry, { backgroundColor: colors.tint }]}
              onPress={() => query.refetch()}
              accessibilityRole="button"
            >
              <ThemedText style={styles.retryText}>{t('common.retry')}</ThemedText>
            </TouchableOpacity>
          }
        />
      );
    }

    if (!credentials || credentials.length === 0) {
      return (
        <CenteredState
          icon="certificate-outline"
          title={t('civic.credentials.empty.title')}
          body={t('civic.credentials.empty.body')}
        />
      );
    }

    return (
      <>
        <ThemedText style={[styles.subtitle, { color: colors.textSecondary }]}>
          {t('civic.credentials.subtitle')}
        </ThemedText>

        {!isOnline && (
          <CivicBadge tone="neutral" icon="cloud-off-outline" label={t('civic.credentials.offline')} />
        )}

        <GroupedList>
          {credentials.map((credential) => (
            <CredentialRow
              key={credential.recordId}
              credential={credential}
              colors={colors}
              t={t}
              onPress={() => openDetail(credential.recordId)}
            />
          ))}
        </GroupedList>
      </>
    );
  };

  return (
    <Screen
      gap={20}
      refreshing={query.isRefetching}
      onRefresh={() => query.refetch()}
    >
      <StackHeader
        title={t('civic.credentials.title')}
        onBack={handleBack}
        backAccessibilityLabel={t('common.back')}
      />
      <SessionGate>{renderBody()}</SessionGate>
    </Screen>
  );
}

interface CredentialRowProps {
  credential: VerifiableCredentialResponse;
  colors: ReturnType<typeof useColors>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onPress: () => void;
}

function CredentialRow({ credential, colors, t, onPress }: CredentialRowProps) {
  const handlePressIn = useHapticPress();
  const primary = primaryCredentialType(credential.types);
  const typeLabel = primary ? humanizeTypeTag(primary) : t('civic.credentials.detail.title');
  const statusMeta = getCredentialStatusMeta(credential.status);
  const preview = claimEntries(credential.claims)[0]?.value ?? '';
  // A compact, opaque-but-stable issuer reference for the list row (6…4).
  const issuerRef = shortenKey(
    userIdFromDid(credential.issuerDid) ?? credential.issuerUserId ?? credential.issuerDid,
    6,
    4,
  );
  const issuedOn = formatMs(credential.issuedAt);

  return (
    <TouchableOpacity onPress={onPress} onPressIn={handlePressIn} accessibilityRole="button" activeOpacity={0.6}>
      <View style={styles.row}>
        <View style={styles.rowHeader}>
          <ThemedText style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
            {typeLabel}
          </ThemedText>
          <CivicBadge
            tone={statusMeta.tone}
            icon={STATUS_ICON[credential.status]}
            label={t(`civic.credentials.status.${statusMeta.labelKey}`)}
          />
        </View>

        {preview.length > 0 && (
          <ThemedText style={[styles.rowPreview, { color: colors.textSecondary }]} numberOfLines={2}>
            {preview}
          </ThemedText>
        )}

        <View style={styles.rowMeta}>
          <ThemedText style={[styles.rowMetaText, { color: colors.textSecondary }]} numberOfLines={1}>
            {t('civic.credentials.issuedBy', { issuer: issuerRef })}
          </ThemedText>
          {issuedOn.length > 0 && (
            <ThemedText style={[styles.rowMetaText, { color: colors.textSecondary }]} numberOfLines={1}>
              {t('civic.credentials.issuedOn', { date: issuedOn })}
            </ThemedText>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
  row: {
    paddingVertical: 16,
    gap: 8,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  rowTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  rowPreview: {
    fontSize: 14,
    lineHeight: 19,
  },
  rowMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  rowMetaText: {
    fontSize: 12,
    flexShrink: 1,
    fontVariant: ['tabular-nums'],
  },
  retry: {
    marginTop: 4,
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 16,
    borderCurve: 'continuous',
  },
  retryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
