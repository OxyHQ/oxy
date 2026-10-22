import { useState } from 'react';
import { View } from 'react-native';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { Slider } from '@oxy.so/bloom/slider';
import type { Update } from '@/hooks/use-updates';
import { useTranslation } from '@/lib/i18n';
import { platformLabel } from '@/lib/updates';

/** Change how much of the audience receives a head. Mount with a `key` per head. */
export function RolloutDialog({
  head,
  isPending,
  onClose,
  onConfirm,
}: {
  head: Update | null;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (rolloutPercent: number) => void;
}) {
  const { t } = useTranslation();
  const [rollout, setRollout] = useState(head?.rolloutPercent ?? 100);

  return (
    <Dialog
      open={!!head}
      onClose={onClose}
      title={t('appsUpdates.rollout.title')}
      description={
        head
          ? t('appsUpdates.rollout.body', {
              runtime: head.runtimeVersion,
              platform: platformLabel(head.platform),
            })
          : ''
      }
      actions={[
        {
          label: isPending ? t('appsUpdates.rollout.saving') : t('appsUpdates.rollout.submit'),
          loading: isPending,
          shouldCloseOnPress: false,
          onPress: () => onConfirm(rollout),
        },
        { label: t('common.cancel'), color: 'cancel' },
      ]}
    >
      <View className="pb-4">
        <Field label={t('appsUpdates.promote.rollout')} description={`${rollout}%`}>
          <Slider
            value={rollout}
            onValueChange={(next) => setRollout(Math.round(next))}
            min={0}
            max={100}
            step={1}
            accessibilityLabel={t('appsUpdates.promote.rollout')}
          />
        </Field>
      </View>
    </Dialog>
  );
}
