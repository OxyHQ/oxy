import { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import type { SafetyPerson } from '@oxy.so/contracts';
import { useOxy } from '../../context/OxyContext';
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
  const results = useQuery({
    queryKey: ['oxy', 'safety', 'people', user?.id, query],
    queryFn: () => oxyServices.safety.people({ query }),
    enabled: query.length >= 2,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
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
      {results.isError ? (
        <AccountFlowNote>{t('supervision.loadError')}</AccountFlowNote>
      ) : (
        results.data?.items
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
      {results.data?.items.length === 0 ? <Text>{t('supervision.noPeople')}</Text> : null}
    </View>
  );
}
