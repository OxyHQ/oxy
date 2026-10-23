import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Dialog } from '@oxy.so/bloom/dialog';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';
import { View } from 'react-native';

import { ApiState } from '@/components/loading/ApiState';
import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import { useCancelJob, useClarityJob } from '@/hooks/use-clarity';
import { useTranslation } from '@/lib/i18n';
import { JobSummary } from './JobSummary';

/** Look a job up by id, watch it progress, and cancel it while it is queued or running. */
export function ClarityJobs() {
  const { t } = useTranslation();
  const [id, setId] = useState('');
  const [requestedId, setRequestedId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const job = useClarityJob(requestedId);
  const cancel = useCancelJob(requestedId);
  const inspect = () => setRequestedId(id.trim());
  const active = job.data !== undefined && ['queued', 'running'].includes(job.data.status);

  return (
    <View className="gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('clarityPage.jobs.title')}</CardTitle>
          <CardDescription>{t('clarityPage.jobs.description')}</CardDescription>
        </CardHeader>
        <CardBody>
          <View className="flex-row items-end gap-3">
            <View className="flex-1">
              <TextFieldInput
                label={t('clarityPage.jobs.id')}
                value={id}
                onChangeText={setId}
                autoCapitalize="none"
                returnKeyType="go"
                onSubmitEditing={inspect}
              />
            </View>
            <Button disabled={!id.trim()} onPress={inspect}>
              {t('clarityPage.jobs.inspect')}
            </Button>
          </View>
        </CardBody>
      </Card>

      {job.isLoading && <DetailSkeleton />}
      {job.isError && <ApiState error={job.error} onRetry={job.refetch} />}
      {job.data && (
        <View className="items-start gap-4 self-stretch">
          <View className="self-stretch">
            <JobSummary job={job.data} />
          </View>
          {active && (
            <Button tone="danger" appearance="outline" onPress={() => setConfirming(true)}>
              {t('clarityPage.jobs.cancel')}
            </Button>
          )}
        </View>
      )}

      {confirming && (
        <Dialog
          open
          onClose={() => setConfirming(false)}
          placement={{ base: 'bottom', md: 'center' }}
          title={t('clarityPage.jobs.cancelTitle')}
          description={t('clarityPage.jobs.cancelBody')}
          actions={[
            { label: t('common.cancel'), color: 'cancel' },
            {
              label: t('clarityPage.jobs.cancel'),
              color: 'destructive',
              loading: cancel.isPending,
              onPress: () =>
                cancel.mutate(undefined, {
                  onSuccess: () => toast.success(t('clarityPage.jobs.cancelled')),
                  onError: () => toast.error(t('clarityPage.jobs.cancelFailed')),
                }),
            },
          ]}
        />
      )}
    </View>
  );
}
