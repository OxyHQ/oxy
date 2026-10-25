import { useCallback } from 'react';
import { Icons } from '@/constants/icons';
import { Badge } from '@oxy.so/bloom/badge';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { useRouter } from 'expo-router';
import {
  Screen,
  StackHeader,
  GroupedList,
  ListRow,
  SessionGate,
  LoadingState,
  STATE_MIN_HEIGHT,
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
  const router = useRouter();
  const { t } = useTranslation();
  const { data, isPending, isError, refetch } = useValidatorInbox();

  const open = useCallback(
    (id: string) => router.push({ pathname: '/(tabs)/(reputation)/validate/[id]', params: { id } }),
    [router],
  );

  const renderBody = () => {
    if (isPending) {
      return <LoadingState description={t('civic.validate.inbox.loading')} />;
    }

    if (isError) {
      return (
        <EmptyState
          icon={Icons.alert}
          title={t('civic.validate.inbox.error.title')}
          description={t('civic.validate.inbox.error.body')}
          action={{ label: t('common.retry'), onPress: () => void refetch() }}
          minHeight={STATE_MIN_HEIGHT}
        />
      );
    }

    if (!data || data.length === 0) {
      return (
        <EmptyState
          icon={Icons.validation}
          title={t('civic.validate.inbox.empty.title')}
          description={t('civic.validate.inbox.empty.body')}
          minHeight={STATE_MIN_HEIGHT}
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
