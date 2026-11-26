import { useState } from 'react';
import { View } from 'react-native';
import { skip } from '@oxy.so/bloom-data';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import type { SafetyPerson } from '@oxy.so/contracts';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useAnswer } from '../../data/answer';
import { peopleSearch } from '../../data/supervision';
import { useI18n } from '../../hooks/useI18n';
import { AccountFlowField, AccountFlowNote } from '../signIn/accountFlowParts';
export function PersonPicker({
  onSelect,
  exclude = [],
}: {
  onSelect: (person: SafetyPerson) => void;
  exclude?: string[];
}) {
  const { oxyServices, user } = useOxy(),
    { t } = useI18n();
  const [text, setText] = useState(''),
    [query, setQuery] = useState('');
  const results = useAnswer(
    peopleSearch,
    ...(query.length >= 2 ? ([oxyServices, user?.id ?? '', query] as const) : ([skip] as const)),
  );
  return (
    <View style={{ gap: 12 }}>
      <AccountFlowNote>{t('supervision.exactHandleHint')}</AccountFlowNote>
      <AccountFlowField
        label={t('supervision.searchLabel')}
        value={text}
        onChange={setText}
        onSubmit={() => setQuery(text.trim().replace(/^@/, ''))}
        error={null}
        testID="supervision-person-query"
      />
      <Button
        onPress={() => setQuery(text.trim().replace(/^@/, ''))}
        disabled={text.trim().length < 2}
        loading={results.isFetching}
      >
        {t('supervision.search')}
      </Button>
      {results.status === 'error' ? (
        <AccountFlowNote>{t('supervision.loadError')}</AccountFlowNote>
      ) : (
        results.value?.items
          .filter((person) => !exclude.includes(person.accountId))
          .map((person) => (
            <Button
              key={person.accountId}
              appearance="plain"
              onPress={() => onSelect(person)}
              testID={`supervision-person-${person.accountId}`}
            >
              {person.displayName ?? person.username ?? t('supervision.account')}{' '}
              {person.username ? `@${person.username}` : ''}
            </Button>
          ))
      )}
      {results.value?.items.length === 0 ? <Text>{t('supervision.noPeople')}</Text> : null}
    </View>
  );
}
