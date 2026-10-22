import type { BillingProfile } from '@oxy.so/contracts';
import { exactDecimalSchema } from '@oxy.so/contracts';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { useUpdateAutoRecharge } from '@/hooks/use-account-billing';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { isZeroAmount } from '@/lib/money';

/**
 * Turn automatic top-ups on or off, and set when and by how much.
 *
 * Both amounts are parsed with the contract's `exactDecimalSchema` (the schema the
 * ledger's NUMERIC columns are declared against) and sent as the strings typed:
 * nothing here is a `number`. An enabled rule needs both, as the API requires.
 */
export function AutoRechargeDialog({
  open,
  onClose,
  accountId,
  profile,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  profile: BillingProfile;
}) {
  const { t } = useTranslation();
  const update = useUpdateAutoRecharge();
  const [enabled, setEnabled] = useState(profile.autoRecharge.enabled);
  const [threshold, setThreshold] = useState(profile.autoRecharge.threshold ?? '');
  const [amount, setAmount] = useState(profile.autoRecharge.amount ?? '');
  const [error, setError] = useState<string | null>(null);

  // Reopening starts from what is saved, not from an abandoned edit.
  useEffect(() => {
    if (open) {
      setEnabled(profile.autoRecharge.enabled);
      setThreshold(profile.autoRecharge.threshold ?? '');
      setAmount(profile.autoRecharge.amount ?? '');
      setError(null);
    }
  }, [open, profile.autoRecharge]);

  const submit = async () => {
    if (!enabled) {
      await save({ enabled: false });
      return;
    }
    const parsedThreshold = exactDecimalSchema.safeParse(threshold.trim());
    const parsedAmount = exactDecimalSchema.safeParse(amount.trim());
    if (!parsedThreshold.success || !parsedAmount.success) {
      setError(t('billingPage.autoRecharge.errorExact'));
      return;
    }
    if (isZeroAmount(parsedAmount.data)) {
      setError(t('billingPage.autoRecharge.errorZero'));
      return;
    }
    await save({ enabled: true, threshold: parsedThreshold.data, amount: parsedAmount.data });
  };

  const save = async (autoRecharge: Parameters<typeof update.mutateAsync>[0]['autoRecharge']) => {
    try {
      await update.mutateAsync({ accountId, autoRecharge });
      toast.success(
        t(autoRecharge.enabled ? 'billingPage.autoRecharge.saved' : 'billingPage.autoRecharge.off'),
      );
      onClose();
    } catch (cause: unknown) {
      toast.error(getErrorMessage(cause, t('billingPage.autoRecharge.failed')));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('billingPage.autoRecharge.title')}
      description={t('billingPage.autoRecharge.description', { currency: profile.currency })}
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        {
          label: t('common.save'),
          onPress: submit,
          loading: update.isPending,
          disabled: update.isPending,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <View className="gap-4 py-2">
        <View className="flex-row items-center justify-between gap-4">
          <Text variant="body-medium">{t('billingPage.autoRecharge.enable')}</Text>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            accessibilityLabel={t('billingPage.autoRecharge.enable')}
          />
        </View>
        {enabled ? (
          <>
            <Field label={t('billingPage.autoRecharge.threshold')} error={error}>
              <TextFieldInput
                label={t('billingPage.autoRecharge.threshold')}
                value={threshold}
                inputMode="decimal"
                placeholder="10.00"
                onChangeText={setThreshold}
              />
            </Field>
            <Field label={t('billingPage.autoRecharge.amount')}>
              <TextFieldInput
                label={t('billingPage.autoRecharge.amount')}
                value={amount}
                inputMode="decimal"
                placeholder="50.00"
                onChangeText={setAmount}
              />
            </Field>
          </>
        ) : null}
      </View>
    </Dialog>
  );
}
