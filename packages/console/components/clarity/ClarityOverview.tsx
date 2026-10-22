import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Chip } from '@oxy.so/bloom/chip';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Muted } from '@oxy.so/bloom/typography';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { ApiState } from '@/components/loading/ApiState';
import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import { useClarityProduct } from '@/hooks/use-clarity';
import { useTranslation } from '@/lib/i18n';
import { CLARITY_SECTIONS } from './sections';

/** What Oxy's catalogue says about Clarity, and a way into each of its tools. */
export function ClarityOverview() {
  const { t } = useTranslation();
  const router = useRouter();
  const product = useClarityProduct();

  if (product.isLoading) return <DetailSkeleton />;
  if (product.isError) return <ApiState error={product.error} onRetry={product.refetch} />;

  return (
    <View className="flex-row flex-wrap gap-6">
      <View className="min-w-72 flex-1 basis-96">
        <Card>
          <CardHeader>
            <CardTitle>{product.data?.name ?? t('clarityPage.overview.productFallback')}</CardTitle>
            <CardDescription>{t('clarityPage.overview.productDescription')}</CardDescription>
          </CardHeader>
          <CardBody>
            {product.data === undefined ? (
              <Muted>{t('clarityPage.overview.notEnabled')}</Muted>
            ) : (
              <View className="items-start gap-3">
                <Chip size="sm" color="success">
                  {product.data.status}
                </Chip>
                <View className="flex-row flex-wrap gap-1.5">
                  {product.data.scopes.map((scope) => (
                    <Chip key={scope} size="sm" hue="soft">
                      {scope}
                    </Chip>
                  ))}
                </View>
              </View>
            )}
          </CardBody>
        </Card>
      </View>
      <View className="min-w-72 flex-1 basis-96">
        <GroupedSection
          title={t('clarityPage.overview.resourcesTitle')}
          footer={t('clarityPage.overview.resourcesDescription')}
          separator="line"
        >
          {CLARITY_SECTIONS.slice(1).map((section) => (
            <GroupedSectionItem
              key={section.id}
              title={t(`clarityPage.sections.${section.id}`)}
              accessibilityRole="link"
              onPress={() => router.navigate(section.href)}
            />
          ))}
        </GroupedSection>
      </View>
    </View>
  );
}
