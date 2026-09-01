import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useOxy } from '@oxyhq/services';
import type { VerifiableCredentialResponse } from '@oxyhq/contracts';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import {
  Screen,
  StackHeader,
  Section,
  GroupedList,
  PrimaryButton,
  SecondaryButton,
  Callout,
  CenteredState,
  SessionGate,
} from '@/components/ui';
import { CivicBadge } from '@/components/civic/CivicBadge';
import { useMyCredentials } from '@/hooks/useCredentials';
import { useVerifyCredential } from '@/hooks/useVerifyCredential';
import { useRevokeCredential } from '@/hooks/useRevokeCredential';
import { useCivicCard } from '@/hooks/useCivicCard';
import { userIdFromDid } from '@/lib/civic/did';
import {
  primaryCredentialType,
  humanizeTypeTag,
  claimEntries,
  getCredentialStatusMeta,
  canRevokeCredential,
} from '@/lib/civic/credential-display';
import { formatDate } from '@/utils/date-utils';
import { useTranslation } from '@/lib/i18n';
import type { MaterialCommunityIconName } from '@/types/icons';

/** Format an epoch-ms timestamp to a short readable date (or empty). */
function formatMs(ms: number | undefined): string {
  return ms != null ? formatDate(new Date(ms).toISOString()) : '';
}

/**
 * Credential detail + verify (+ revoke for the issuer).
 *
 * The credential body (type, claims, issuer, dates, status) is read from the
 * cached "my credentials" list and kept fresh by the verify / revoke results.
 * "Verify" calls `verifyCredential(recordId)` server-side and surfaces an
 * explicit VALID / UNTRUSTED verdict with a friendly reason. When the current
 * user is the ORIGINAL issuer of an active credential, a biometric-gated
 * "Revoke" action is offered — the server is authoritative on who may revoke.
 *
 * NATIVE-ONLY for the revoke path (it acts on a record the issuer signed).
 */
export default function CredentialDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();
  const { recordId } = useLocalSearchParams<{ recordId: string }>();
  const { user } = useOxy();
  const myId = user?.id ?? null;

  const listQuery = useMyCredentials();
  const fromList = useMemo<VerifiableCredentialResponse | null>(
    () => listQuery.data?.credentials.find((c) => c.recordId === recordId) ?? null,
    [listQuery.data, recordId],
  );

  const verify = useVerifyCredential(recordId ?? null);
  const revoke = useRevokeCredential(t('civic.credentials.revoke.biometricReason'));

  // The freshest known credential: a revoke result wins, then a verify result,
  // then the cached list row.
  const credential = revoke.result?.credential ?? verify.result?.credential ?? fromList;

  // Resolve the issuer's public card for a human name where possible.
  const issuerUserId = credential ? userIdFromDid(credential.issuerDid) : null;
  const issuerCard = useCivicCard(issuerUserId);
  const issuerName = issuerCard.data?.card?.name;

  const canRevoke = credential ? canRevokeCredential(credential, myId) : false;

  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/(settings)/credentials');
  }, [router]);

  const handleRevoke = useCallback(() => {
    if (credential) void revoke.revoke(credential);
  }, [revoke, credential]);

  const renderBody = () => {
    // Resolving the credential from the list for the first time.
    if (!credential && listQuery.isPending) {
      return <CenteredState loading body={t('civic.credentials.loading')} />;
    }

    if (!credential) {
      return (
        <CenteredState
          icon="file-document-alert-outline"
          title={t('civic.credentials.detail.notFoundTitle')}
          body={t('civic.credentials.detail.notFoundBody')}
          action={
            <View style={styles.action}>
              <PrimaryButton label={t('common.back')} onPress={handleBack} fullWidth={false} />
            </View>
          }
        />
      );
    }

    const primary = primaryCredentialType(credential.types);
    const typeLabel = primary ? humanizeTypeTag(primary) : t('civic.credentials.detail.title');
    const statusMeta = getCredentialStatusMeta(credential.status);
    const claims = claimEntries(credential.claims);
    const issuerDisplay = issuerName ?? credential.issuerUserId ?? credential.issuerDid;

    const issuedOn = formatMs(credential.issuedAt);
    const expiresOn = formatMs(credential.expiresAt);
    const revokedOn = formatMs(credential.revokedAt);

    return (
      <>
        {/* Type + status hero */}
        <View style={styles.hero}>
          <ThemedText style={[styles.heroType, { color: colors.text }]} numberOfLines={2}>
            {typeLabel}
          </ThemedText>
          <CivicBadge
            tone={statusMeta.tone}
            icon="certificate-outline"
            label={t(`civic.credentials.status.${statusMeta.labelKey}`)}
          />
        </View>

        {/* Verify verdict */}
        {verify.state === 'valid' && (
          <View style={styles.verdict}>
            <CivicBadge emphasis tone="positive" icon="check-decagram" label={t('civic.credentials.verify.validTitle')} />
            <ThemedText style={[styles.verdictDesc, { color: colors.textSecondary }]}>
              {t('civic.credentials.verify.validBody')}
            </ThemedText>
          </View>
        )}
        {verify.state === 'invalid' && (
          <View style={styles.verdict}>
            <CivicBadge emphasis tone="danger" icon="alert-decagram" label={t('civic.credentials.verify.invalidTitle')} />
            <ThemedText style={[styles.verdictDesc, { color: colors.textSecondary }]}>
              {t(`civic.credentials.verify.reason.${verify.reasonCode ?? 'generic'}`)}
            </ThemedText>
          </View>
        )}
        {verify.state === 'error' && (
          <View style={styles.verdict}>
            <CivicBadge emphasis tone="caution" icon="cloud-alert" label={t('civic.credentials.verify.errorTitle')} />
            <ThemedText style={[styles.verdictDesc, { color: colors.textSecondary }]}>
              {t('civic.credentials.verify.errorBody')}
            </ThemedText>
          </View>
        )}

        {/* Verify action */}
        <SecondaryButton
          icon="shield-search"
          label={verify.state === 'verifying' ? t('civic.credentials.verify.verifying') : t('civic.credentials.verify.cta')}
          loading={verify.state === 'verifying'}
          onPress={() => void verify.verify()}
        />

        {/* Claims */}
        <Section title={t('civic.credentials.detail.claimsTitle')}>
          {claims.length === 0 ? (
            <ThemedText style={[styles.muted, { color: colors.textSecondary }]}>
              {t('civic.credentials.detail.noClaims')}
            </ThemedText>
          ) : (
            <GroupedList>
              {claims.map((entry) => (
                <View key={entry.key} style={styles.claimRow}>
                  <ThemedText style={[styles.claimLabel, { color: colors.textSecondary }]}>
                    {entry.label}
                  </ThemedText>
                  <ThemedText style={[styles.claimValue, { color: colors.text }]}>{entry.value}</ThemedText>
                </View>
              ))}
            </GroupedList>
          )}
        </Section>

        {/* Issuer */}
        <Section title={t('civic.credentials.detail.issuerTitle')}>
          <View style={styles.issuerRow}>
            <MaterialCommunityIcons name="account-badge-outline" size={22} color={colors.identityIconPublicKey} />
            <View style={styles.issuerText}>
              <ThemedText style={[styles.issuerName, { color: colors.text }]} numberOfLines={1}>
                {issuerDisplay || t('civic.credentials.unknownIssuer')}
              </ThemedText>
              <ThemedText style={[styles.issuerDid, { color: colors.textSecondary }]} selectable numberOfLines={1}>
                {credential.issuerDid}
              </ThemedText>
            </View>
          </View>
        </Section>

        {/* Validity */}
        <Section title={t('civic.credentials.detail.datesTitle')}>
          <GroupedList>
            {issuedOn.length > 0 && (
              <DateRow colors={colors} icon="calendar-check" label={t('civic.credentials.issuedOn', { date: issuedOn })} />
            )}
            {credential.status === 'revoked' && revokedOn.length > 0 ? (
              <DateRow
                colors={colors}
                icon="close-octagon-outline"
                tone={colors.error}
                label={t('civic.credentials.revokedOn', { date: revokedOn })}
              />
            ) : expiresOn.length > 0 ? (
              <DateRow
                colors={colors}
                icon="calendar-remove"
                tone={credential.status === 'expired' ? colors.warning : undefined}
                label={t(
                  credential.status === 'expired' ? 'civic.credentials.expiredOn' : 'civic.credentials.expiresOn',
                  { date: expiresOn },
                )}
              />
            ) : (
              <DateRow colors={colors} icon="infinity" label={t('civic.credentials.noExpiry')} />
            )}
          </GroupedList>
        </Section>

        {/* Record id */}
        <Section title={t('civic.credentials.detail.recordLabel')}>
          <ThemedText style={[styles.recordValue, { color: colors.textSecondary }]} selectable numberOfLines={2}>
            {credential.recordId}
          </ThemedText>
        </Section>

        {/* Revoke — issuer-only, active-only */}
        {canRevoke && revoke.state !== 'done' && (
          <View style={styles.revokeBlock}>
            <Callout tone="danger" icon="alert-outline">
              {t('civic.credentials.revoke.confirmBody')}
            </Callout>
            {revoke.biometricFailed && (
              <ThemedText style={[styles.inlineWarn, { color: colors.warning }]}>
                {t('civic.credentials.revoke.biometricFailed')}
              </ThemedText>
            )}
            {revoke.state === 'error' && (
              <ThemedText style={[styles.inlineWarn, { color: colors.error }]}>
                {t(`civic.credentials.revoke.error.${revoke.errorCode ?? 'generic'}`)}
              </ThemedText>
            )}
            <PrimaryButton
              tone="danger"
              icon="fingerprint"
              label={t('civic.credentials.revoke.cta')}
              loading={revoke.state === 'revoking'}
              onPress={handleRevoke}
            />
            {revoke.state === 'revoking' && (
              <ThemedText style={[styles.muted, styles.centerText, { color: colors.textSecondary }]}>
                {t('civic.credentials.revoke.submitting')}
              </ThemedText>
            )}
          </View>
        )}

        {revoke.state === 'done' && (
          <View style={styles.revokeDone}>
            <MaterialCommunityIcons name="check-circle-outline" size={20} color={colors.success} />
            <ThemedText style={[styles.revokeDoneText, { color: colors.textSecondary }]}>
              {t('civic.credentials.revoke.doneBody')}
            </ThemedText>
          </View>
        )}
      </>
    );
  };

  return (
    <Screen gap={24}>
      <StackHeader
        title={t('civic.credentials.detail.title')}
        onBack={handleBack}
        backAccessibilityLabel={t('common.back')}
      />
      <SessionGate>{renderBody()}</SessionGate>
    </Screen>
  );
}

interface DateRowProps {
  colors: ReturnType<typeof useColors>;
  icon: MaterialCommunityIconName;
  label: string;
  tone?: string;
}

function DateRow({ colors, icon, label, tone }: DateRowProps) {
  return (
    <View style={styles.dateRow}>
      <MaterialCommunityIcons name={icon} size={20} color={tone ?? colors.textTertiary} />
      <ThemedText style={[styles.dateText, { color: tone ?? colors.text }]}>{label}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: 'center',
    marginTop: 4,
  },
  hero: {
    gap: 12,
    alignItems: 'flex-start',
  },
  heroType: {
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  verdict: {
    gap: 8,
    alignItems: 'flex-start',
  },
  verdictDesc: {
    fontSize: 13,
    lineHeight: 19,
  },
  muted: {
    fontSize: 14,
    lineHeight: 20,
  },
  centerText: {
    textAlign: 'center',
  },
  claimRow: {
    gap: 3,
    paddingVertical: 14,
  },
  claimLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  claimValue: {
    fontSize: 15,
    lineHeight: 21,
  },
  issuerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  issuerText: {
    flex: 1,
    gap: 2,
  },
  issuerName: {
    fontSize: 16,
    fontWeight: '600',
  },
  issuerDid: {
    fontSize: 12,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
  },
  dateText: {
    fontSize: 14,
  },
  recordValue: {
    fontSize: 13,
    lineHeight: 19,
  },
  revokeBlock: {
    gap: 12,
  },
  inlineWarn: {
    fontSize: 13,
    lineHeight: 18,
  },
  revokeDone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  revokeDoneText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
});
