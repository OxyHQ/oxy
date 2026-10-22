import { useState } from 'react';
import { View } from 'react-native';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Chip } from '@oxy.so/bloom/chip';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { currencyCodeSchema, exactDecimalSchema } from '@oxy.so/contracts';
import { useReportLabels } from '@/components/billing/labels';
import type { CreateBudgetInput } from '@/hooks/use-inference-reporting';
import { useTranslation } from '@/lib/i18n';
import { formatBasisPoints } from '@/lib/money';
import {
  BUDGET_ALERT_THRESHOLDS_BPS,
  BUDGET_ENFORCEMENTS,
  BUDGET_PERIODS,
  type BudgetEnforcement,
  type BudgetPeriod,
} from '@/lib/reporting';

/**
 * Create a budget scoped to one application.
 *
 * Three properties are structural rather than validated after the fact:
 *
 *  - **The scope and its target cannot disagree.** The budget is always scoped to
 *    `applicationId`; this screen never offers another scope.
 *  - **The ceiling is exact.** It is edited as text and parsed with
 *    `exactDecimalSchema` (the schema the ledger's NUMERIC columns are declared
 *    against), so a value that would become a float is refused with the field
 *    named. Nothing here calls `Number()` on an amount.
 *  - **Alert thresholds come from the closed set** the column's CHECK admits.
 *
 * A ceiling of zero is refused: it would refuse every request while reading like
 * "no limit configured" in the list. Disabling is what the status is for.
 */
export function BudgetCreateDialog({
  open,
  onOpenChange,
  applicationId,
  currencies,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  /** The currencies the account actually holds a balance in. */
  currencies: ReadonlyArray<string>;
  isPending: boolean;
  onSubmit: (input: CreateBudgetInput) => void;
}) {
  const { t } = useTranslation();
  const labels = useReportLabels();

  const [period, setPeriod] = useState<BudgetPeriod>('monthly');
  const [limitAmount, setLimitAmount] = useState('');
  const [currency, setCurrency] = useState<string>(currencies[0] ?? '');
  const [enforcement, setEnforcement] = useState<BudgetEnforcement>('hard_stop');
  const [thresholds, setThresholds] = useState<ReadonlyArray<number>>([7500, 10000]);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const amount = exactDecimalSchema.safeParse(limitAmount.trim());
    if (!amount.success) {
      setError(t('billingPage.budgets.form.errorExact'));
      return;
    }
    // A string test, not a numeric one: `0`, `0.00` and `0.000000000000` are the
    // same amount, and none of them is a usable ceiling.
    if (/^0+(\.0*)?$/.test(limitAmount.trim())) {
      setError(t('billingPage.budgets.form.errorZero'));
      return;
    }

    let resolvedCurrency: string | undefined;
    if (currency.length > 0) {
      const parsed = currencyCodeSchema.safeParse(currency);
      if (!parsed.success) {
        setError(t('billingPage.budgets.form.errorCurrency'));
        return;
      }
      resolvedCurrency = parsed.data;
    }

    setError(null);
    onSubmit({
      period,
      limitAmount: amount.data,
      currency: resolvedCurrency,
      enforcement,
      alertThresholdBps: thresholds,
      scope: 'application',
      scopeApplicationId: applicationId,
    });
  };

  const toggleThreshold = (bps: number) => {
    setThresholds((current) =>
      current.includes(bps)
        ? current.filter((entry) => entry !== bps)
        : BUDGET_ALERT_THRESHOLDS_BPS.filter((entry) => entry === bps || current.includes(entry)),
    );
  };

  const periodItems = BUDGET_PERIODS.map((value) => ({ value, label: labels.period(value) }));
  const enforcementItems = BUDGET_ENFORCEMENTS.map((value) => ({
    value,
    label: labels.enforcement(value),
  }));
  const currencyItems = currencies.map((value) => ({ value, label: value }));

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={t('billingPage.budgets.form.title')}
      description={t('billingPage.budgets.form.description')}
      scrollable
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        {
          label: isPending
            ? t('billingPage.budgets.form.creating')
            : t('billingPage.budgets.form.submit'),
          onPress: handleSubmit,
          disabled: isPending,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <View className="gap-5 py-2">
        <View className="flex-row gap-4">
          <Field label={t('billingPage.budgets.form.period')} style={{ flex: 1 }}>
            <Select value={period} onValueChange={(next) => setPeriod(next as BudgetPeriod)}>
              <SelectTrigger>
                <SelectValue>{() => labels.period(period)}</SelectValue>
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('billingPage.budgets.form.period')}
                items={periodItems}
                renderItem={(item) => (
                  <SelectItem value={item.value} label={item.label}>
                    <SelectItemIndicator />
                    <SelectItemText>{item.label}</SelectItemText>
                  </SelectItem>
                )}
              />
            </Select>
          </Field>
          <Field label={t('billingPage.budgets.form.ceiling')} style={{ flex: 1 }}>
            <TextFieldInput
              label={t('billingPage.budgets.form.ceiling')}
              value={limitAmount}
              inputMode="decimal"
              placeholder="250.00"
              onValueChange={setLimitAmount}
            />
          </Field>
        </View>

        {currencies.length > 0 && (
          <Field label={t('billingPage.budgets.form.currency')}>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger>
                <SelectValue>{() => currency}</SelectValue>
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('billingPage.budgets.form.currency')}
                items={currencyItems}
                renderItem={(item) => (
                  <SelectItem value={item.value} label={item.label}>
                    <SelectItemIndicator />
                    <SelectItemText>{item.label}</SelectItemText>
                  </SelectItem>
                )}
              />
            </Select>
          </Field>
        )}

        <Field label={t('billingPage.budgets.form.atCeiling')}>
          <Select
            value={enforcement}
            onValueChange={(next) => setEnforcement(next as BudgetEnforcement)}
          >
            <SelectTrigger>
              <SelectValue>{() => labels.enforcement(enforcement)}</SelectValue>
              <SelectIcon />
            </SelectTrigger>
            <SelectContent
              label={t('billingPage.budgets.form.atCeiling')}
              items={enforcementItems}
              renderItem={(item) => (
                <SelectItem value={item.value} label={item.label}>
                  <SelectItemIndicator />
                  <SelectItemText>{item.label}</SelectItemText>
                </SelectItem>
              )}
            />
          </Select>
        </Field>

        <Field
          label={t('billingPage.budgets.form.alertAt')}
          description={t('billingPage.budgets.form.alertHint')}
          multiple
        >
          <View className="flex-row flex-wrap gap-1.5">
            {BUDGET_ALERT_THRESHOLDS_BPS.map((bps) => (
              <Chip
                key={bps}
                role="checkbox"
                checked={thresholds.includes(bps)}
                onPress={() => toggleThreshold(bps)}
              >
                {formatBasisPoints(bps)}
              </Chip>
            ))}
          </View>
        </Field>

        {error !== null && <Admonition type="error">{error}</Admonition>}
      </View>
    </Dialog>
  );
}
