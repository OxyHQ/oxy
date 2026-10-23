import type { SearchMode } from '@clarity.surf/sdk';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Linking, View } from 'react-native';
import { useState } from 'react';

import { ApiState } from '@/components/loading/ApiState';
import { useClaritySearch } from '@/hooks/use-clarity';
import { useTranslation } from '@/lib/i18n';

const MODES: ReadonlyArray<SearchMode> = ['hybrid', 'lexical', 'semantic'];

/** A live query against Clarity's public index. */
export function ClaritySearch() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('hybrid');
  const search = useClaritySearch();
  const submit = () => {
    if (query.trim()) search.mutate({ query: query.trim(), mode });
  };

  return (
    <View className="gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('clarityPage.search.title')}</CardTitle>
          <CardDescription>{t('clarityPage.search.description')}</CardDescription>
        </CardHeader>
        <CardBody>
          <View className="gap-4">
            <TextFieldInput
              label={t('clarityPage.search.query')}
              value={query}
              onChangeText={setQuery}
              placeholder={t('clarityPage.search.placeholder')}
              returnKeyType="search"
              onSubmitEditing={submit}
            />
            <View className="flex-row flex-wrap items-center justify-between gap-3">
              <SegmentedControl
                type="radio"
                label={t('clarityPage.search.mode')}
                value={mode}
                onValueChange={(value) => setMode(value as SearchMode)}
              >
                {MODES.map((item) => (
                  <SegmentedControlItem key={item} value={item}>
                    <SegmentedControlItemText>
                      {t(`clarityPage.search.modes.${item}`)}
                    </SegmentedControlItemText>
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
              <Button
                onPress={submit}
                disabled={search.isPending || !query.trim()}
                loading={search.isPending}
              >
                {t('clarityPage.search.submit')}
              </Button>
            </View>
          </View>
        </CardBody>
      </Card>

      {search.isError && <ApiState error={search.error} onRetry={submit} />}
      {search.data?.degraded && (
        <Admonition type="warning">{t('clarityPage.search.degradedTitle')}</Admonition>
      )}
      {search.data &&
        (search.data.data.length === 0 ? (
          <EmptyState variant="compact" title={t('clarityPage.search.none')} />
        ) : (
          <GroupedSection separator="line">
            {search.data.data.map((result) => (
              <GroupedSectionItem
                key={result.id}
                title={result.title ?? result.canonicalUrl}
                titleNumberOfLines={2}
                description={
                  result.snippet ?? result.description ?? t('clarityPage.search.noSnippet')
                }
                value={result.publisher ?? new URL(result.canonicalUrl).hostname}
                accessibilityRole="link"
                onPress={() => void Linking.openURL(result.canonicalUrl)}
              />
            ))}
          </GroupedSection>
        ))}
    </View>
  );
}
