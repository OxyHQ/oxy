import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import {
  Screen,
  StackHeader,
  Section,
  GroupedList,
  CenteredState,
  PrimaryButton,
  SecondaryButton,
  SessionGate,
} from '@/components/ui';
import { CivicBadge } from '@/components/civic/CivicBadge';
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
        <CenteredState
          icon="verified"
          iconColor={colors.success}
          title={t('civic.validate.vote.done.title')}
          body={t('civic.validate.vote.done.body')}
          action={
            <View style={styles.action}>
              <PrimaryButton label={t('common.done')} onPress={handleClose} fullWidth={false} />
            </View>
          }
        />
      );
    }

    if (state === 'error') {
      return (
        <CenteredState
          icon="alert"
          iconColor={colors.error}
          title={t('civic.validate.vote.error.title')}
          body={t(`civic.validate.error.${errorCode ?? 'generic'}`)}
          action={
            <View style={styles.action}>
              <PrimaryButton label={t('common.close')} onPress={handleClose} fullWidth={false} />
            </View>
          }
        />
      );
    }

    if (isPending && !request) {
      return <CenteredState loading />;
    }

    if (isError && !request) {
      return (
        <CenteredState
          icon="alert"
          title={t('civic.validate.inbox.error.title')}
          body={t('civic.validate.inbox.error.body')}
          action={
            <PrimaryButton label={t('common.retry')} onPress={() => refetch()} fullWidth={false} />
          }
        />
      );
    }

    if (!request) {
      return (
        <CenteredState
          icon="validation"
          title={t('civic.validate.vote.gone.title')}
          body={t('civic.validate.vote.gone.body')}
          action={
            <View style={styles.action}>
              <PrimaryButton label={t('common.close')} onPress={handleClose} fullWidth={false} />
            </View>
          }
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
            <CivicBadge tone="caution" icon="star" label={t('civic.validate.highValue')} />
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
          <PrimaryButton
            tone="success"
            icon="check"
            label={t('civic.validate.vote.valid')}
            onPress={() => vote('valid')}
            disabled={busy}
            style={styles.verdictBtn}
          />
          <PrimaryButton
            tone="danger"
            icon="close"
            label={t('civic.validate.vote.invalid')}
            onPress={() => vote('invalid')}
            disabled={busy}
            style={styles.verdictBtn}
          />
        </View>

        <SecondaryButton label={t('civic.validate.vote.abstain')} onPress={() => vote('abstain')} disabled={busy} />

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
