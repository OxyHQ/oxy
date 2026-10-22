import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import {
  type ApplicationInferenceLimits,
  useApplicationInferenceLimits,
  useWriteApplicationInferenceLimits,
} from '@/hooks/use-routing-policy';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { limitsFromForm, type LimitsForm, limitsToForm } from '@/lib/inference-limits';
import { SectionHeader, TextInputField } from './ui';

const FIELD_KEYS: ReadonlyArray<keyof ApplicationInferenceLimits> = [
  'maxConcurrentRealtimeSessions',
  'maxConcurrentRealtimeSessionsPerCredential',
  'maxConcurrentRequests',
  'maxRequestsPerUtcDay',
];

/**
 * The inference limits Oxy applies when Kaana asks to serve this application
 * (Kaana ADR 0002, Alia ADR 0017 §5). Spend is budgets, in the next tab.
 */
export function InferenceLimitsSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const canRead = access.can('inference:routing:read');
  const canWrite = access.can('inference:routing:write');
  const limitsQuery = useApplicationInferenceLimits(application._id, canRead);
  const writeLimits = useWriteApplicationInferenceLimits();
  const [form, setForm] = useState<LimitsForm | null>(null);

  useEffect(() => {
    if (limitsQuery.data !== undefined) setForm(limitsToForm(limitsQuery.data));
  }, [limitsQuery.data]);

  if (!canRead) return null;

  const parsed = form === null ? null : limitsFromForm(form);
  const hasError = parsed !== null && 'error' in parsed;

  const handleSave = async () => {
    if (parsed === null || 'error' in parsed) return;
    try {
      await writeLimits.mutateAsync({ applicationId: application._id, limits: parsed.limits });
      toast.success(t('appsInference.limits.saved'));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('appsInference.limits.saveFailed')));
    }
  };

  return (
    <View className="gap-4">
      <SectionHeader
        title={t('appsInference.limits.title')}
        description={t('appsInference.limits.description')}
      />
      {form === null ? (
        <Skeleton.Box width="100%" height={160} />
      ) : (
        <View className="gap-4">
          {FIELD_KEYS.map((key) => (
            <TextInputField
              key={key}
              label={t(`appsInference.limits.fields.${key}.label`)}
              help={t(`appsInference.limits.fields.${key}.help`)}
              placeholder={t('appsInference.limits.noLimit')}
              inputMode="numeric"
              value={form[key]}
              disabled={!canWrite}
              onChange={(value) => setForm({ ...form, [key]: value })}
            />
          ))}
        </View>
      )}
      {hasError && <Text className="text-sm text-destructive">{parsed.error}</Text>}
      {canWrite && (
        <View className="flex-row">
          <Button
            size="sm"
            onPress={handleSave}
            disabled={parsed === null || hasError}
            loading={writeLimits.isPending}
          >
            {t('appsInference.limits.save')}
          </Button>
        </View>
      )}
    </View>
  );
}
