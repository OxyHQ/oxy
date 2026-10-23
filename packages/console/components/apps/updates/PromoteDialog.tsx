import { useState } from 'react';
import { View } from 'react-native';
import { Chip } from '@oxy.so/bloom/chip';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { Slider } from '@oxy.so/bloom/slider';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import type { Update } from '@/hooks/use-updates';
import { useTranslation } from '@/lib/i18n';
import { CHANNEL_NAME_PATTERN, platformLabel } from '@/lib/updates';

/** Copy a head to another channel at a chosen rollout. Mount with a `key` per head. */
export function PromoteDialog({
  head,
  channelNames,
  isPending,
  onClose,
  onConfirm,
}: {
  head: Update | null;
  channelNames: Array<string>;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (toChannel: string, rolloutPercent: number | undefined) => void;
}) {
  const { t } = useTranslation();
  const [toChannel, setToChannel] = useState('');
  const [rollout, setRollout] = useState(100);

  // The parent keys this dialog on the head id, so each selection remounts with
  // fresh form state — no effect needed to re-seed.
  const suggestions = head ? channelNames.filter((name) => name !== head.channel) : [];

  const handleConfirm = () => {
    const trimmed = toChannel.trim();
    if (!trimmed) {
      toast.error(t('appsUpdates.promote.enterChannel'));
      return;
    }
    if (!CHANNEL_NAME_PATTERN.test(trimmed)) {
      toast.error(t('appsUpdates.promote.invalidChannel'));
      return;
    }
    onConfirm(trimmed, rollout);
  };

  return (
    <Dialog
      open={!!head}
      onClose={onClose}
      title={t('appsUpdates.promote.title')}
      description={
        head
          ? t('appsUpdates.promote.body', {
              runtime: head.runtimeVersion,
              platform: platformLabel(head.platform),
            })
          : ''
      }
      actions={[
        {
          label: isPending ? t('appsUpdates.promote.promoting') : t('appsUpdates.promote.submit'),
          loading: isPending,
          disabled: !toChannel.trim(),
          shouldCloseOnPress: false,
          onPress: handleConfirm,
        },
        { label: t('common.cancel'), color: 'cancel' },
      ]}
    >
      <View className="gap-4 pb-4">
        <View className="gap-2">
          <Field label={t('appsUpdates.promote.target')}>
            <TextFieldInput
              label={t('appsUpdates.promote.target')}
              value={toChannel}
              onValueChange={setToChannel}
              placeholder="production"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          {suggestions.length > 0 && (
            <View className="flex-row flex-wrap gap-1.5">
              {suggestions.map((name) => (
                <Chip key={name} size="sm" variant="outlined" onPress={() => setToChannel(name)}>
                  {name}
                </Chip>
              ))}
            </View>
          )}
        </View>
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
