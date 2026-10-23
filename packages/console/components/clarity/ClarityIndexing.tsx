import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';
import { View } from 'react-native';

import { ApiState } from '@/components/loading/ApiState';
import { useIndexUrls } from '@/hooks/use-clarity';
import { useTranslation } from '@/lib/i18n';
import { JobSummary } from './JobSummary';

/** Queue up to 50 public URLs for indexing. */
export function ClarityIndexing() {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const index = useIndexUrls();
  const urls = value.split(/\s+/).filter(Boolean);

  return (
    <View className="gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('clarityPage.indexing.title')}</CardTitle>
          <CardDescription>{t('clarityPage.indexing.description')}</CardDescription>
        </CardHeader>
        <CardBody>
          <View className="gap-4">
            <Textarea
              label={t('clarityPage.indexing.urls')}
              rows={8}
              value={value}
              onChangeText={setValue}
              placeholder={'https://example.com/page\nhttps://example.com/another'}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View className="items-start">
              <Button
                disabled={index.isPending || urls.length === 0}
                loading={index.isPending}
                onPress={() =>
                  index.mutate(urls, {
                    onSuccess: () => toast.success(t('clarityPage.indexing.queued')),
                  })
                }
              >
                {t('clarityPage.indexing.submit')}
              </Button>
            </View>
          </View>
        </CardBody>
      </Card>
      {index.isError && <ApiState error={index.error} />}
      {index.data && <JobSummary job={index.data} />}
    </View>
  );
}
