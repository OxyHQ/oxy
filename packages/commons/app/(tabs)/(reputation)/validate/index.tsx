import React, { useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import {
  Screen,
  StackHeader,
  GroupedList,
  ListRow,
  CenteredState,
  SessionGate,
} from '@/components/ui';
import { CivicBadge } from '@/components/civic/CivicBadge';
import { useValidatorInbox } from '@/hooks/useValidatorInbox';
import { prettyActionType } from '@/lib/civic/validation-format';
import { useTranslation } from '@/lib/i18n';

/**
 * Validator inbox — the citizen-duty queue.
 *
 * Lists the pending validation requests this user was randomly selected to judge.
 * Tapping one opens the vote screen. Live queue (the SDK never caches it); the
 * vote screen invalidates this query after a vote/recusal. Flat, hairline rows.
 */
export default function ValidatorInboxScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();
  const { data, isPending, isError, refetch } = useValidatorInbox();

  const open = useCallback(
    (id: string) => router.push({ pathname: '/(tabs)/(reputation)/validate/[id]', params: { id } }),
    [router],
  );

  const renderBody = () => {
    if (isPending) {
      return <CenteredState loading body={t('civic.validate.inbox.loading')} />;
    }

    if (isError) {
      return (
        <CenteredState
          icon="alert"
          title={t('civic.validate.inbox.error.title')}
          body={t('civic.validate.inbox.error.body')}
          action={
            <TouchableOpacity
              style={[styles.retry, { backgroundColor: colors.tint }]}
              onPress={() => refetch()}
              accessibilityRole="button"
            >
              <ThemedText style={styles.retryText}>{t('common.retry')}</ThemedText>
            </TouchableOpacity>
          }
        />
      );
    }

    if (!data || data.length === 0) {
      return (
        <CenteredState
          icon="validation"
          title={t('civic.validate.inbox.empty.title')}
          body={t('civic.validate.inbox.empty.body')}
        />
      );
    }

    return (
      <GroupedList>
        {data.map((req) => (
          <ListRow
            key={req.id}
            icon="validation"
            title={prettyActionType(req.actionType)}
            subtitle={t('civic.validate.inbox.requestSubtitle')}
            onPress={() => open(req.id)}
            showChevron
            trailing={
              req.highValue ? (
                <CivicBadge tone="caution" icon="star" label={t('civic.validate.highValue')} />
              ) : undefined
            }
          />
        ))}
      </GroupedList>
    );
  };

  return (
    <Screen>
      <StackHeader
        title={t('civic.validate.inbox.title')}
        subtitle={t('civic.validate.inbox.subtitle')}
        onBack={() => router.back()}
        backAccessibilityLabel={t('common.back')}
      />
      <SessionGate>{renderBody()}</SessionGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
