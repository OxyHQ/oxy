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
import { useTranslation } from '@/lib/i18n';
import { formatBasisPoints } from '@/lib/money';
import {
  BUDGET_ALERT_THRESHOLDS_BPS,
  BUDGET_ENFORCEMENTS,
  BUDGET_PERIODS,
  type Budget,
  type BudgetEnforcement,
  type BudgetPeriod,
} from '@/lib/reporting';

/** What the dialog collects. Period and currency are fixed once a budget exists. */
export interface BudgetFormValues {
  period: BudgetPeriod;
  limitAmount: string;
  currency?: string;
  enforcement: BudgetEnforcement;
  alertThresholdBps: ReadonlyArray<number>;
}

/**
 * Create or edit a budget scoped to one application.
 *
 * Three properties are structural rather than validated after the fact:
 *
 *  - **The scope cannot disagree with its target.** The caller maps these values
 *    onto an application-scoped budget; this dialog never offers another scope.
 *  - **The ceiling is exact.** It is edited as text and parsed with
 *    `exactDecimalSchema` (the schema the ledger's NUMERIC columns are declared
 *    against), so a value that would become a float is refused with the field
 *    named. Nothing here calls `Number()` on an amount.
 *  - **Alert thresholds come from the closed set** the column's CHECK admits.
 *
 * A ceiling of zero is refused: it would refuse every request while reading like
 * "no limit configured" in the list. Disabling is what the status is for.
 *
 * Mount it with a `key` per target so each opening starts from fresh state.
 */
export function BudgetDialog({
  open,
  onOpenChange,
  budget,
  currencies,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The budget being edited; absent when creating. */
  budget?: Budget;
  /** The currencies the account actually holds a balance in. */
  currencies: ReadonlyArray<string>;
  isPending: boolean;
  onSubmit: (values: BudgetFormValues) => void;
}) {
  const { t } = useTranslation();
  const labels = useReportLabels();
  const isEdit = budget !== undefined;

  const [period, setPeriod] = useState<BudgetPeriod>(budget?.period ?? 'monthly');
  const [limitAmount, setLimitAmount] = useState(budget?.limitAmount ?? '');
  const [currency, setCurrency] = useState<string>(budget?.currency ?? currencies[0] ?? '');
  const [enforcement, setEnforcement] = useState<BudgetEnforcement>(
    budget?.enforcement ?? 'hard_stop',
  );
  const [thresholds, setThresholds] = useState<ReadonlyArray<number>>(
    budget?.alertThresholdBps ?? [7500, 10000],
  );
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const amount = exactDecimalSchema.safeParse(limitAmount.trim());
    if (!amount.success) {
      setError(t('appsInference.budgets.form.errorExact'));
      return;
    }
    // A string test, not a numeric one: `0`, `0.00` and `0.000000000000` are the
    // same amount, and none of them is a usable ceiling.
    if (/^0+(\.0*)?$/.test(limitAmount.trim())) {
      setError(t('appsInference.budgets.form.errorZero'));
      return;
    }

    let resolvedCurrency: string | undefined;
    if (currency.length > 0) {
      const parsed = currencyCodeSchema.safeParse(currency);
      if (!parsed.success) {
        setError(t('appsInference.budgets.form.errorCurrency'));
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
      title={
        isEdit ? t('appsInference.budgets.form.editTitle') : t('appsInference.budgets.form.title')
      }
      description={t('appsInference.budgets.form.description')}
      scrollable
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        {
          label: isEdit
            ? t('appsInference.budgets.form.save')
            : isPending
              ? t('appsInference.budgets.form.creating')
              : t('appsInference.budgets.form.submit'),
          onPress: handleSubmit,
          loading: isPending,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <View className="gap-5 py-2">
        <View className="flex-row gap-4">
          <Field label={t('appsInference.budgets.form.period')} style={{ flex: 1 }}>
            <Select
              value={period}
              disabled={isEdit}
              onValueChange={(next) => setPeriod(next as BudgetPeriod)}
            >
              <SelectTrigger>
                <SelectValue>{() => labels.period(period)}</SelectValue>
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('appsInference.budgets.form.period')}
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
          <Field label={t('appsInference.budgets.form.ceiling')} style={{ flex: 1 }}>
            <TextFieldInput
              label={t('appsInference.budgets.form.ceiling')}
              value={limitAmount}
              inputMode="decimal"
              placeholder="250.00"
              onValueChange={setLimitAmount}
            />
          </Field>
        </View>

        {currencies.length > 0 && (
          <Field label={t('appsInference.budgets.form.currency')}>
            <Select value={currency} disabled={isEdit} onValueChange={setCurrency}>
              <SelectTrigger>
                <SelectValue>{() => currency}</SelectValue>
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('appsInference.budgets.form.currency')}
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

        <Field label={t('appsInference.budgets.form.atCeiling')}>
          <Select
            value={enforcement}
            onValueChange={(next) => setEnforcement(next as BudgetEnforcement)}
          >
            <SelectTrigger>
              <SelectValue>{() => labels.enforcement(enforcement)}</SelectValue>
              <SelectIcon />
            </SelectTrigger>
            <SelectContent
              label={t('appsInference.budgets.form.atCeiling')}
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
          label={t('appsInference.budgets.form.alertAt')}
          description={t('appsInference.budgets.form.alertHint')}
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
