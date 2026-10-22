import { Admonition } from '@oxy.so/bloom/admonition';
import { Chip } from '@oxy.so/bloom/chip';
import { DataTableFilter } from '@oxy.so/bloom/data-table';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { currencyCodeSchema, exactDecimalSchema } from '@oxy.so/contracts';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useApplicationCredentials, useApplications } from '@/hooks/use-applications';
import type { CreateBudgetInput } from '@/hooks/use-inference-reporting';
import { useTranslation } from '@/lib/i18n';
import { formatBasisPoints } from '@/lib/money';
import {
  BUDGET_ALERT_THRESHOLDS_BPS,
  BUDGET_ENFORCEMENTS,
  BUDGET_PERIODS,
  type BudgetEnforcement,
  type BudgetPeriod,
  type BudgetScope,
} from '@/lib/reporting';
import { useReportLabels } from './labels';

/**
 * Create a budget against the account's spend.
 *
 * Three properties are structural rather than validated after the fact:
 *
 *  - **The scope and its target cannot disagree.** {@link CreateBudgetInput} is a
 *    discriminated union mirroring the API's own body schema.
 *  - **The ceiling is exact.** It is edited as text and parsed with
 *    `exactDecimalSchema` (the schema the ledger's NUMERIC columns are declared
 *    against), so a value that would become a float is refused with the field
 *    named. Nothing here calls `Number()` on an amount.
 *  - **Alert thresholds come from the closed set** the column's CHECK admits.
 *
 * A ceiling of zero is refused: it would refuse every request while reading like
 * "no limit configured" in the list. Disabling is what the status is for.
 */
export function BudgetFormDialog({
  open,
  onOpenChange,
  accountId,
  currencies,
  fixedApplicationId,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  /** The currencies the account actually holds a balance in. */
  currencies: ReadonlyArray<string>;
  /**
   * When set, the budget is scoped to this application and the scope picker is
   * not offered — the per-application screen already answers the question.
   */
  fixedApplicationId?: string;
  isPending: boolean;
  onSubmit: (input: CreateBudgetInput) => void;
}) {
  const { t } = useTranslation();
  const labels = useReportLabels();

  const [scope, setScope] = useState<BudgetScope>(
    fixedApplicationId === undefined ? 'account' : 'application',
  );
  const [applicationId, setApplicationId] = useState<string>(fixedApplicationId ?? '');
  const [credentialId, setCredentialId] = useState<string>('');
  const [period, setPeriod] = useState<BudgetPeriod>('monthly');
  const [limitAmount, setLimitAmount] = useState('');
  const [currency, setCurrency] = useState<string>(currencies[0] ?? '');
  const [enforcement, setEnforcement] = useState<BudgetEnforcement>('hard_stop');
  const [thresholds, setThresholds] = useState<ReadonlyArray<number>>([7500, 10000]);
  const [error, setError] = useState<string | null>(null);

  const applicationsQuery = useApplications();
  const applications = applicationsQuery.data ?? [];
  const credentialsQuery = useApplicationCredentials(applicationId, scope === 'credential');
  const credentials = credentialsQuery.data ?? [];

  const scopeOptions = useMemo(
    () => [
      { value: 'account' as const, label: t('billingPage.budgets.form.scopeAccount') },
      { value: 'application' as const, label: t('billingPage.budgets.form.scopeApplication') },
      { value: 'credential' as const, label: t('billingPage.budgets.form.scopeCredential') },
    ],
    [t],
  );

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

    const common = {
      period,
      limitAmount: amount.data,
      currency: resolvedCurrency,
      enforcement,
      alertThresholdBps: thresholds,
    };

    if (scope === 'application') {
      if (applicationId.length === 0) {
        setError(t('billingPage.budgets.form.errorApplication'));
        return;
      }
      setError(null);
      onSubmit({ ...common, scope: 'application', scopeApplicationId: applicationId });
      return;
    }

    if (scope === 'credential') {
      if (credentialId.length === 0) {
        setError(t('billingPage.budgets.form.errorCredential'));
        return;
      }
      setError(null);
      onSubmit({ ...common, scope: 'credential', scopeApplicationCredentialId: credentialId });
      return;
    }

    setError(null);
    onSubmit({ ...common, scope: 'account', scopeAccountId: accountId });
  };

  const toggleThreshold = (bps: number) => {
    setThresholds((current) =>
      current.includes(bps)
        ? current.filter((entry) => entry !== bps)
        : BUDGET_ALERT_THRESHOLDS_BPS.filter((entry) => entry === bps || current.includes(entry)),
    );
  };

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
        {fixedApplicationId === undefined && (
          <Field label={t('billingPage.budgets.form.appliesTo')}>
            <DataTableFilter
              label={t('billingPage.budgets.form.appliesTo')}
              value={scope}
              options={scopeOptions}
              onValueChange={(value) => setScope(value as BudgetScope)}
            />
          </Field>
        )}

        {fixedApplicationId === undefined && scope !== 'account' && (
          <Field
            label={t('billingPage.budgets.form.application')}
            description={
              applications.length === 0 ? t('billingPage.budgets.form.noApplications') : undefined
            }
          >
            <DataTableFilter
              label={t('billingPage.budgets.form.application')}
              value={applicationId}
              options={[
                { value: '', label: t('billingPage.budgets.form.chooseApplication') },
                ...applications.map((application) => ({
                  value: application._id,
                  label: application.name,
                })),
              ]}
              onValueChange={(value) => {
                setApplicationId(value);
                setCredentialId('');
              }}
            />
          </Field>
        )}

        {scope === 'credential' && applicationId.length > 0 && (
          <Field
            label={t('billingPage.budgets.form.credential')}
            description={
              credentials.length === 0 && !credentialsQuery.isLoading
                ? t('billingPage.budgets.form.noCredentials')
                : undefined
            }
          >
            <DataTableFilter
              label={t('billingPage.budgets.form.credential')}
              value={credentialId}
              options={[
                { value: '', label: t('billingPage.budgets.form.chooseCredential') },
                ...credentials.map((credential) => ({
                  value: credential._id,
                  label: `${credential.name} · ${credential.environment}`,
                })),
              ]}
              onValueChange={setCredentialId}
            />
          </Field>
        )}

        <View className="flex-row gap-4">
          <View className="flex-1">
            <Field label={t('billingPage.budgets.form.period')}>
              <DataTableFilter
                label={t('billingPage.budgets.form.period')}
                value={period}
                options={BUDGET_PERIODS.map((entry) => ({
                  value: entry,
                  label: labels.period(entry),
                }))}
                onValueChange={(value) => setPeriod(value as BudgetPeriod)}
              />
            </Field>
          </View>
          <View className="flex-1">
            <Field label={t('billingPage.budgets.form.ceiling')}>
              <TextFieldInput
                label={t('billingPage.budgets.form.ceiling')}
                value={limitAmount}
                inputMode="decimal"
                placeholder="250.00"
                onChangeText={setLimitAmount}
              />
            </Field>
          </View>
        </View>

        {currencies.length > 0 && (
          <Field label={t('billingPage.budgets.form.currency')}>
            <DataTableFilter
              label={t('billingPage.budgets.form.currency')}
              value={currency}
              options={currencies.map((code) => ({ value: code, label: code }))}
              onValueChange={setCurrency}
            />
          </Field>
        )}

        <Field label={t('billingPage.budgets.form.atCeiling')}>
          <DataTableFilter
            label={t('billingPage.budgets.form.atCeiling')}
            value={enforcement}
            options={BUDGET_ENFORCEMENTS.map((entry) => ({
              value: entry,
              label: labels.enforcement(entry),
            }))}
            onValueChange={(value) => setEnforcement(value as BudgetEnforcement)}
          />
        </Field>

        <Field
          label={t('billingPage.budgets.form.alertAt')}
          description={t('billingPage.budgets.form.alertHint')}
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
