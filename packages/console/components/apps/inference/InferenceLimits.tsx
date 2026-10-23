import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { Field } from '@oxy.so/bloom/field';
import { GroupedSection } from '@oxy.so/bloom/grouped-section';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useAppDetail } from '@/components/apps/app-context';
import {
  type ApplicationInferenceLimits,
  useApplicationInferenceLimits,
  useWriteApplicationInferenceLimits,
} from '@/hooks/use-routing-policy';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { limitsFromForm, type LimitsForm, limitsToForm } from '@/lib/inference-limits';

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
export function InferenceLimits() {
  const { t } = useTranslation();
  const { application, access } = useAppDetail();
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

  if (limitsQuery.isError) {
    return <Admonition type="error">{t('appsInference.limits.loadFailed')}</Admonition>;
  }

  return (
    <GroupedSection
      title={t('appsInference.limits.title')}
      footer={t('appsInference.limits.description')}
      separator="none"
    >
      {form === null ? (
        <View className="p-4">
          <Skeleton.Box width="100%" height={160} />
        </View>
      ) : (
        <View className="gap-4 p-4">
          {FIELD_KEYS.map((key) => (
            <Field
              key={key}
              label={t(`appsInference.limits.fields.${key}.label`)}
              description={t(`appsInference.limits.fields.${key}.help`)}
              disabled={!canWrite}
            >
              <TextFieldInput
                label={t(`appsInference.limits.fields.${key}.label`)}
                placeholder={t('appsInference.limits.noLimit')}
                inputMode="numeric"
                value={form[key]}
                onValueChange={(value) => setForm({ ...form, [key]: value })}
              />
            </Field>
          ))}
          {hasError && <Admonition type="error">{parsed.error}</Admonition>}
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
      )}
    </GroupedSection>
  );
}
