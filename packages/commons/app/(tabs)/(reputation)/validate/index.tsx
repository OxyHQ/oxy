import React, { useCallback } from 'react';
import { Text } from '@oxy.so/bloom/typography';
import { Icons } from '@/constants/icons';
import { Badge } from '@oxy.so/bloom/badge';
import { Loading } from '@oxy.so/bloom/loading';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import {
  Screen,
  StackHeader,
  GroupedList,
  ListRow,
  SessionGate,
} from '@/components/ui';
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
      return <EmptyState
               illustration={<Loading variant="spinner" size="lg" />}
               description={t('civic.validate.inbox.loading')}
               minHeight={360}
             />;
    }

    if (isError) {
      return (
        <EmptyState
          icon={Icons.alert}
          title={t('civic.validate.inbox.error.title')}
          description={t('civic.validate.inbox.error.body')}
          footer={
            <TouchableOpacity
              style={[styles.retry, { backgroundColor: colors.tint }]}
              onPress={() => refetch()}
              accessibilityRole="button"
            >
              <Text style={styles.retryText}>{t('common.retry')}</Text>
            </TouchableOpacity>
          }
          minHeight={360}
        />
      );
    }

    if (!data || data.length === 0) {
      return (
        <EmptyState
          icon={Icons.validation}
          title={t('civic.validate.inbox.empty.title')}
          description={t('civic.validate.inbox.empty.body')}
          minHeight={360}
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
                <Badge
                  appearance="subtle"
                  tone="warning"
                  size="label-small"
                  icon={Icons.star}
                  content={t('civic.validate.highValue')}
                />
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
