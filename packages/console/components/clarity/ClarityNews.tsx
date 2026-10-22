import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { Muted } from '@oxy.so/bloom/typography';
import { Linking, View } from 'react-native';

import { ApiState } from '@/components/loading/ApiState';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useClarityNews } from '@/hooks/use-clarity';
import { useTranslation } from '@/lib/i18n';

/** The latest clustered stories, each with the sources behind it. */
export function ClarityNews() {
  const { t } = useTranslation();
  const news = useClarityNews();

  if (news.isLoading) return <ListSkeleton />;
  if (news.isError) return <ApiState error={news.error} onRetry={news.refetch} />;
  const stories = news.data?.data ?? [];

  return (
    <View className="gap-6">
      <View className="flex-row items-center justify-between gap-3">
        <Muted>{t('clarityPage.news.title')}</Muted>
        <Button
          appearance="outline"
          size="sm"
          leadingIcon={RiRefreshLine}
          loading={news.isFetching}
          onPress={() => void news.refetch()}
        >
          {t('clarityPage.news.refresh')}
        </Button>
      </View>
      {stories.length === 0 ? (
        <EmptyState variant="compact" title={t('clarityPage.news.none')} />
      ) : (
        <View className="flex-row flex-wrap gap-4">
          {stories.map((story) => (
            <View key={story.id} className="min-w-72 flex-1 basis-96">
              <Card>
                <CardHeader>
                  <CardTitle>{story.title}</CardTitle>
                  <CardDescription>
                    {t('clarityPage.news.meta', {
                      count: story.sourceCount,
                      date: new Date(story.lastPublishedAt).toLocaleString(),
                    })}
                  </CardDescription>
                </CardHeader>
                <CardBody>
                  <View className="gap-3">
                    <Muted>{story.summary ?? t('clarityPage.news.noSummary')}</Muted>
                    <GroupedSection separator="line">
                      {story.articles.slice(0, 3).map((article) => (
                        <GroupedSectionItem
                          key={article.id}
                          title={article.publisher ?? article.title ?? article.canonicalUrl}
                          accessibilityRole="link"
                          onPress={() => void Linking.openURL(article.canonicalUrl)}
                        />
                      ))}
                    </GroupedSection>
                  </View>
                </CardBody>
              </Card>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
