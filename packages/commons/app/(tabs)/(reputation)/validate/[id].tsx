import React, { useCallback, useMemo } from 'react';
import { Badge } from '@oxy.so/bloom/badge';
import { Loading } from '@oxy.so/bloom/loading';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Icons } from '@/constants/icons';
import { fullWidthControl } from '@/constants/styles';
import { Button } from '@oxy.so/bloom/button';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import {
  Screen,
  StackHeader,
  Section,
  GroupedList,
  SessionGate,
} from '@/components/ui';
import { useValidatorInbox } from '@/hooks/useValidatorInbox';
import { useValidationVote } from '@/hooks/useValidationVote';
import { prettyActionType, payloadEntries } from '@/lib/civic/validation-format';
import { useTranslation } from '@/lib/i18n';

/**
 * Juror vote screen. Shows the request the user was selected to judge and the
 * verdict actions. A signed verdict (Valid / Invalid / Abstain) is gated behind
 * the device biometric; Recuse needs none. The request itself is read from the
 * shared inbox query (no single-request endpoint) — if it's no longer there
 * (already voted / closed), we say so.
 */
export default function ValidationVoteScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data, isPending, isError, refetch } = useValidatorInbox();
  const request = useMemo(() => data?.find((r) => r.id === id) ?? null, [data, id]);

  const { state, biometricFailed, errorCode, vote, deny } = useValidationVote(
    request?.id ?? null,
    request?.payloadHash ?? null,
    t('civic.validate.vote.biometricReason'),
  );

  const handleClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/(reputation)/validate');
  }, [router]);

  const busy = state === 'voting' || state === 'denying';

  const renderBody = () => {
    if (state === 'done') {
      return (
        <EmptyState
          illustration={<Icons.verified size="3xl" fill={colors.success} />}
          title={t('civic.validate.vote.done.title')}
          description={t('civic.validate.vote.done.body')}
          footer={
            <View style={styles.action}>
              <Button appearance="solid" tone="accent" size="lg" onPress={handleClose}>{t('common.done')}</Button>
            </View>
          }
          minHeight={360}
        />
      );
    }

    if (state === 'error') {
      return (
        <EmptyState
          illustration={<Icons.alert size="3xl" fill={colors.error} />}
          title={t('civic.validate.vote.error.title')}
          description={t(`civic.validate.error.${errorCode ?? 'generic'}`)}
          footer={
            <View style={styles.action}>
              <Button appearance="solid" tone="accent" size="lg" onPress={handleClose}>{t('common.close')}</Button>
            </View>
          }
          minHeight={360}
        />
      );
    }

    if (isPending && !request) {
      return <EmptyState
               illustration={<Loading variant="spinner" size="lg" />}
               minHeight={360}
             />;
    }

    if (isError && !request) {
      return (
        <EmptyState
          icon={Icons.alert}
          title={t('civic.validate.inbox.error.title')}
          description={t('civic.validate.inbox.error.body')}
          action={{ label: t('common.retry'), onPress: () => refetch() }}
          minHeight={360}
        />
      );
    }

    if (!request) {
      return (
        <EmptyState
          icon={Icons.validation}
          title={t('civic.validate.vote.gone.title')}
          description={t('civic.validate.vote.gone.body')}
          footer={
            <View style={styles.action}>
              <Button appearance="solid" tone="accent" size="lg" onPress={handleClose}>{t('common.close')}</Button>
            </View>
          }
          minHeight={360}
        />
      );
    }

    const entries = payloadEntries(request.payload);

    return (
      <>
        <View style={styles.headerBlock}>
          <ThemedText style={[styles.actionType, { color: colors.text }]}>
            {prettyActionType(request.actionType)}
          </ThemedText>
          {request.highValue && (
            <Badge
              appearance="subtle"
              tone="warning"
              size="label-small"
              icon={Icons.star}
              content={t('civic.validate.highValue')}
            />
          )}
        </View>

        <ThemedText style={[styles.prompt, { color: colors.textSecondary }]}>
          {t('civic.validate.vote.prompt')}
        </ThemedText>

        <Section title={t('civic.validate.vote.detailsTitle')}>
          {entries.length === 0 ? (
            <ThemedText style={[styles.muted, { color: colors.textSecondary }]}>
              {t('civic.validate.vote.noDetails')}
            </ThemedText>
          ) : (
            <GroupedList>
              {entries.map((e) => (
                <View key={e.key} style={styles.detailRow}>
                  <ThemedText style={[styles.detailKey, { color: colors.textSecondary }]}>{e.key}</ThemedText>
                  <ThemedText style={[styles.detailValue, { color: colors.text }]} numberOfLines={3}>
                    {e.value}
                  </ThemedText>
                </View>
              ))}
            </GroupedList>
          )}
        </Section>

        {biometricFailed && (
          <ThemedText style={[styles.inlineWarn, { color: colors.warning }]}>
            {t('civic.validate.vote.biometricFailed')}
          </ThemedText>
        )}

        <View style={styles.verdictRow}>
          <Button appearance="solid" tone="success" size="lg" icon={Icons.check} onPress={() => vote('valid')} disabled={busy} style={[fullWidthControl, styles.verdictBtn]}>{t('civic.validate.vote.valid')}</Button>
          <Button appearance="solid" tone="danger" size="lg" icon={Icons.close} onPress={() => vote('invalid')} disabled={busy} style={[fullWidthControl, styles.verdictBtn]}>{t('civic.validate.vote.invalid')}</Button>
        </View>

        <Button appearance="outline" tone="accent" size="lg" onPress={() => vote('abstain')} disabled={busy} style={fullWidthControl}>{t('civic.validate.vote.abstain')}</Button>

        <TouchableOpacity style={styles.recuse} onPress={deny} disabled={busy} accessibilityRole="button">
          <ThemedText style={[styles.recuseText, { color: colors.textSecondary }]}>
            {t('civic.validate.vote.recuse')}
          </ThemedText>
        </TouchableOpacity>

        {busy && (
          <ThemedText style={[styles.muted, styles.centerText, { color: colors.textSecondary }]}>
            {t('civic.validate.vote.submitting')}
          </ThemedText>
        )}
      </>
    );
  };

  return (
    <Screen gap={20}>
      <StackHeader title={t('civic.validate.vote.title')} onBack={handleClose} backAccessibilityLabel={t('common.back')} />
      <SessionGate>{renderBody()}</SessionGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: 'center',
    marginTop: 4,
  },
  headerBlock: {
    gap: 10,
    alignItems: 'flex-start',
  },
  actionType: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  prompt: {
    fontSize: 15,
    lineHeight: 21,
  },
  muted: {
    fontSize: 14,
    lineHeight: 20,
  },
  centerText: {
    textAlign: 'center',
  },
  detailRow: {
    gap: 3,
    paddingVertical: 14,
  },
  detailKey: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  detailValue: {
    fontSize: 15,
    lineHeight: 21,
  },
  inlineWarn: {
    fontSize: 13,
    lineHeight: 18,
  },
  verdictRow: {
    flexDirection: 'row',
    gap: 12,
  },
  verdictBtn: {
    flex: 1,
  },
  recuse: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  recuseText: {
    fontSize: 15,
  },
});
