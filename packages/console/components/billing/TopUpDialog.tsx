import { exactDecimalSchema } from '@oxy.so/contracts';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';

import { useAccountTopUpCheckout } from '@/hooks/use-account-billing';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { isZeroAmount } from '@/lib/money';

/**
 * Start a hosted top-up checkout for the account's prepaid balance.
 *
 * The amount is parsed with the contract's own schema, so one that would become a
 * float is refused here rather than after the card is charged. The balance moves
 * when the payment provider confirms the charge, never when the checkout opens.
 */
export function TopUpDialog({
  open,
  onClose,
  accountId,
  currency,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  currency: string | undefined;
}) {
  const { t } = useTranslation();
  const checkout = useAccountTopUpCheckout();
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const parsed = exactDecimalSchema.safeParse(amount.trim());
    if (!parsed.success) {
      setError(t('billingPage.overview.topUpExact'));
      return;
    }
    if (isZeroAmount(parsed.data)) {
      setError(t('billingPage.overview.topUpZero'));
      return;
    }
    setError(null);
    try {
      const result = await checkout.mutateAsync({
        accountId,
        amount: parsed.data,
        successUrl: `${window.location.origin}/billing?topup=success`,
        cancelUrl: `${window.location.origin}/billing?topup=canceled`,
      });
      window.location.href = result.url;
    } catch (cause: unknown) {
      toast.error(getErrorMessage(cause, t('billingPage.overview.topUpFailed')));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('billingPage.overview.addFunds')}
      description={t('billingPage.overview.topUpDescription', {
        currency: currency === undefined ? '' : ` (${currency})`,
      })}
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        {
          label: t('billingPage.overview.continueToPayment'),
          onPress: submit,
          loading: checkout.isPending,
          disabled: checkout.isPending,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <Field label={t('billingPage.overview.amount')} error={error}>
        <TextFieldInput
          label={t('billingPage.overview.amount')}
          value={amount}
          inputMode="decimal"
          placeholder="50.00"
          onChangeText={setAmount}
        />
      </Field>
    </Dialog>
  );
}
