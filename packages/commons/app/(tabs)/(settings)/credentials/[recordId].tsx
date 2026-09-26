import React, { useCallback, useMemo } from 'react';
import { Text } from '@oxy.so/bloom/typography';
import { Admonition } from '@oxy.so/bloom/admonition';
import { bloomToneFor } from '@/lib/civic/card-presentation';
import { Badge } from '@oxy.so/bloom/badge';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { fullWidthControl } from '@/constants/styles';
import { Button } from '@oxy.so/bloom/button';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AppIcon, Icons } from '@/constants/icons';
import { useOxy } from '@oxy.so/services';
import type { VerifiableCredentialResponse } from '@oxy.so/contracts';
import { useColors } from '@/hooks/useColors';
import {
  Screen,
  StackHeader,
  Section,
  GroupedList,
  SessionGate,
  LoadingState,
  STATE_MIN_HEIGHT,
} from '@/components/ui';
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
import type { IconName } from '@/constants/icons';

/** Format an epoch-ms timestamp to a short readable date (or empty). */
function formatMs(ms: number | undefined): string {
  return ms != null ? formatDate(new Date(ms).toISOString()) : '';
}

/**
 * Credential detail + verify (+ revoke for the issuer).
 *
 * The credential body (type, claims, issuer, dates, status) is read from the
 * cached "my credentials" list and kept fresh by the verify / revoke results.
 * "Verify" calls `civic.credentials.verify(recordId)` server-side and surfaces an
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
      return <LoadingState description={t('civic.credentials.loading')} />;
    }

    if (!credential) {
      return (
        <EmptyState
          icon={Icons.alert}
          title={t('civic.credentials.detail.notFoundTitle')}
          description={t('civic.credentials.detail.notFoundBody')}
          footer={
            <View className="items-center mt-space-4">
              <Button appearance="solid" tone="accent" size="lg" onPress={handleBack}>{t('common.back')}</Button>
            </View>
          }
          minHeight={STATE_MIN_HEIGHT}
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
        <View className="gap-space-12 items-start">
          <Text style={[styles.heroType, { color: colors.text }]} numberOfLines={2}>
            {typeLabel}
          </Text>
          <Badge
            appearance="subtle"
            tone={bloomToneFor(statusMeta.tone)}
            size="label-small"
            icon={Icons.credential}
            content={t(`civic.credentials.status.${statusMeta.labelKey}`)}
          />
        </View>

        {/* Verify verdict */}
        {verify.state === 'valid' && (
          <View className="gap-space-8 items-start">
            <Badge
              appearance="subtle"
              tone="success"
              size="label-medium"
              icon={Icons.verified}
              content={t('civic.credentials.verify.validTitle')}
            />
            <Text style={[styles.verdictDesc, { color: colors.textSecondary }]}>
              {t('civic.credentials.verify.validBody')}
            </Text>
          </View>
        )}
        {verify.state === 'invalid' && (
          <View className="gap-space-8 items-start">
            <Badge
              appearance="subtle"
              tone="danger"
              size="label-medium"
              icon={Icons.alertStrong}
              content={t('civic.credentials.verify.invalidTitle')}
            />
            <Text style={[styles.verdictDesc, { color: colors.textSecondary }]}>
              {t(`civic.credentials.verify.reason.${verify.reasonCode ?? 'generic'}`)}
            </Text>
          </View>
        )}
        {verify.state === 'error' && (
          <View className="gap-space-8 items-start">
            <Badge
              appearance="subtle"
              tone="warning"
              size="label-medium"
              icon={Icons.alert}
              content={t('civic.credentials.verify.errorTitle')}
            />
            <Text style={[styles.verdictDesc, { color: colors.textSecondary }]}>
              {t('civic.credentials.verify.errorBody')}
            </Text>
          </View>
        )}

        {/* Verify action */}
        <Button appearance="outline" tone="accent" size="lg" icon={Icons.search} onPress={() => void verify.verify()} loading={verify.state === 'verifying'} style={fullWidthControl}>{verify.state === 'verifying' ? t('civic.credentials.verify.verifying') : t('civic.credentials.verify.cta')}</Button>

        {/* Claims */}
        <Section title={t('civic.credentials.detail.claimsTitle')}>
          {claims.length === 0 ? (
            <Text style={[styles.muted, { color: colors.textSecondary }]}>
              {t('civic.credentials.detail.noClaims')}
            </Text>
          ) : (
            <GroupedList>
              {claims.map((entry) => (
                <View key={entry.key} style={styles.claimRow}>
                  <Text style={[styles.claimLabel, { color: colors.textSecondary }]}>
                    {entry.label}
                  </Text>
                  <Text style={[styles.claimValue, { color: colors.text }]}>{entry.value}</Text>
                </View>
              ))}
            </GroupedList>
          )}
        </Section>

        {/* Issuer */}
        <Section title={t('civic.credentials.detail.issuerTitle')}>
          <View style={styles.issuerRow}>
            <Icons.verifiedOutline size='md' fill={colors.identityIconPublicKey} />
            <View className="flex-1 gap-space-2">
              <Text style={[styles.issuerName, { color: colors.text }]} numberOfLines={1}>
                {issuerDisplay || t('civic.credentials.unknownIssuer')}
              </Text>
              <Text style={[styles.issuerDid, { color: colors.textSecondary }]} selectable numberOfLines={1}>
                {credential.issuerDid}
              </Text>
            </View>
          </View>
        </Section>

        {/* Validity */}
        <Section title={t('civic.credentials.detail.datesTitle')}>
          <GroupedList>
            {issuedOn.length > 0 && (
              <DateRow colors={colors} icon="scheduled" label={t('civic.credentials.issuedOn', { date: issuedOn })} />
            )}
            {credential.status === 'revoked' && revokedOn.length > 0 ? (
              <DateRow
                colors={colors}
                icon="closeCircle"
                tone={colors.error}
                label={t('civic.credentials.revokedOn', { date: revokedOn })}
              />
            ) : expiresOn.length > 0 ? (
              <DateRow
                colors={colors}
                icon="unscheduled"
                tone={credential.status === 'expired' ? colors.warning : undefined}
                label={t(
                  credential.status === 'expired' ? 'civic.credentials.expiredOn' : 'civic.credentials.expiresOn',
                  { date: expiresOn },
                )}
              />
            ) : (
              <DateRow colors={colors} icon="unlimited" label={t('civic.credentials.noExpiry')} />
            )}
          </GroupedList>
        </Section>

        {/* Record id */}
        <Section title={t('civic.credentials.detail.recordLabel')}>
          <Text style={[styles.recordValue, { color: colors.textSecondary }]} selectable numberOfLines={2}>
            {credential.recordId}
          </Text>
        </Section>

        {/* Revoke — issuer-only, active-only */}
        {canRevoke && revoke.state !== 'done' && (
          <View className="gap-space-12">
            <Admonition type="error">
              {t('civic.credentials.revoke.confirmBody')}
            </Admonition>
            {revoke.biometricFailed && (
              <Text style={[styles.inlineWarn, { color: colors.warning }]}>
                {t('civic.credentials.revoke.biometricFailed')}
              </Text>
            )}
            {revoke.state === 'error' && (
              <Text style={[styles.inlineWarn, { color: colors.error }]}>
                {t(`civic.credentials.revoke.error.${revoke.errorCode ?? 'generic'}`)}
              </Text>
            )}
            <Button appearance="solid" tone="danger" size="lg" icon={Icons.personhood} onPress={handleRevoke} loading={revoke.state === 'revoking'} style={fullWidthControl}>{t('civic.credentials.revoke.cta')}</Button>
            {revoke.state === 'revoking' && (
              <Text style={[styles.muted, styles.centerText, { color: colors.textSecondary }]}>
                {t('civic.credentials.revoke.submitting')}
              </Text>
            )}
          </View>
        )}

        {revoke.state === 'done' && (
          <View style={styles.revokeDone}>
            <Icons.checkCircle size='md' fill={colors.success} />
            <Text style={[styles.revokeDoneText, { color: colors.textSecondary }]}>
              {t('civic.credentials.revoke.doneBody')}
            </Text>
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
  icon: IconName;
  label: string;
  tone?: string;
}

function DateRow({ colors, icon, label, tone }: DateRowProps) {
  return (
    <View style={styles.dateRow}>
      <AppIcon name={icon} size='md' fill={tone ?? colors.textTertiary} />
      <Text style={[styles.dateText, { color: tone ?? colors.text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
