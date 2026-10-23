import { currencyCodeSchema, exactDecimalSchema } from '@oxy.so/contracts';
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
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { useApplicationCredentials, useApplications } from '@/hooks/use-applications';
import {
  type CreateBudgetInput,
  useCreateBudget,
  useUpdateBudget,
} from '@/hooks/use-inference-reporting';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { formatBasisPoints, isZeroAmount } from '@/lib/money';
import {
  BUDGET_ALERT_THRESHOLDS_BPS,
  BUDGET_ENFORCEMENTS,
  BUDGET_PERIODS,
  type Budget,
  type BudgetEnforcement,
  type BudgetPeriod,
  type BudgetScope,
} from '@/lib/reporting';

const SCOPES = [
  'account',
  'application',
  'credential',
] as const satisfies ReadonlyArray<BudgetScope>;

/**
 * Create a budget against the account's spend, or edit one.
 *
 * A budget is a ceiling on spend, never a pot of money, so editing one moves
 * nothing. Editing changes the ceiling, what happens at it and the alert
 * thresholds; the scope, period and currency are fixed at creation, because
 * re-pointing a budget would re-interpret every alert already recorded against it.
 *
 * The ceiling is typed as text and parsed with `exactDecimalSchema` (the schema the
 * ledger's NUMERIC columns are declared against), then sent as the string typed;
 * a zero ceiling is refused because it would refuse every request while reading
 * like "no limit" in the list. Disabling is what the status is for.
 */
export function BudgetFormDialog({
  open,
  onClose,
  accountId,
  currencies,
  budget,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  /** The currencies the account actually holds a balance in. */
  currencies: ReadonlyArray<string>;
  /** Present when editing. */
  budget?: Budget;
}) {
  const { t } = useTranslation();
  const createBudget = useCreateBudget();
  const updateBudget = useUpdateBudget();
  const editing = budget !== undefined;

  const [scope, setScope] = useState<BudgetScope>('account');
  const [applicationId, setApplicationId] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [period, setPeriod] = useState<BudgetPeriod>('monthly');
  const [limitAmount, setLimitAmount] = useState('');
  const [currency, setCurrency] = useState(currencies[0] ?? '');
  const [enforcement, setEnforcement] = useState<BudgetEnforcement>('hard_stop');
  const [thresholds, setThresholds] = useState<ReadonlyArray<number>>([7500, 10000]);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts from the budget being edited, or from a clean form.
  useEffect(() => {
    if (!open) return;
    setScope(budget?.scope ?? 'account');
    setApplicationId('');
    setCredentialId('');
    setPeriod(budget?.period ?? 'monthly');
    setLimitAmount(budget?.limitAmount ?? '');
    setCurrency(budget?.currency ?? currencies[0] ?? '');
    setEnforcement(budget?.enforcement ?? 'hard_stop');
    setThresholds(budget?.alertThresholdBps ?? [7500, 10000]);
    setError(null);
  }, [open, budget, currencies]);

  const applications = useApplications().data ?? [];
  const credentialsQuery = useApplicationCredentials(
    applicationId,
    !editing && scope === 'credential' && applicationId.length > 0,
  );
  const credentials = credentialsQuery.data ?? [];

  const applicationItems = applications.map((application) => ({
    value: application._id,
    label: application.name,
  }));
  const credentialItems = credentials.map((credential) => ({
    value: credential._id,
    label: `${credential.name} · ${credential.environment}`,
  }));

  const toggleThreshold = (bps: number) => {
    setThresholds((current) =>
      BUDGET_ALERT_THRESHOLDS_BPS.filter((entry) =>
        entry === bps ? !current.includes(bps) : current.includes(entry),
      ),
    );
  };

  const submit = async () => {
    const amount = exactDecimalSchema.safeParse(limitAmount.trim());
    if (!amount.success) {
      setError(t('billingPage.budgets.form.errorExact'));
      return;
    }
    if (isZeroAmount(amount.data)) {
      setError(t('billingPage.budgets.form.errorZero'));
      return;
    }

    try {
      if (editing) {
        await updateBudget.mutateAsync({
          accountId,
          budgetId: budget.spendingLimitId,
          input: { limitAmount: amount.data, enforcement, alertThresholdBps: thresholds },
        });
        toast.success(t('billingPage.budgets.updated'));
        onClose();
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
      let input: CreateBudgetInput;
      if (scope === 'application') {
        if (applicationId.length === 0) {
          setError(t('billingPage.budgets.form.errorApplication'));
          return;
        }
        input = { ...common, scope, scopeApplicationId: applicationId };
      } else if (scope === 'credential') {
        if (credentialId.length === 0) {
          setError(t('billingPage.budgets.form.errorCredential'));
          return;
        }
        input = { ...common, scope, scopeApplicationCredentialId: credentialId };
      } else {
        input = { ...common, scope, scopeAccountId: accountId };
      }
      await createBudget.mutateAsync({ accountId, input });
      toast.success(t('billingPage.budgets.created'));
      onClose();
    } catch (cause: unknown) {
      toast.error(
        getErrorMessage(
          cause,
          t(editing ? 'billingPage.budgets.changeFailed' : 'billingPage.budgets.createFailed'),
        ),
      );
    }
  };

  const pending = createBudget.isPending || updateBudget.isPending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t(editing ? 'billingPage.budgets.form.editTitle' : 'billingPage.budgets.form.title')}
      description={t('billingPage.budgets.form.description')}
      scrollable
      actions={[
        { label: t('common.cancel'), color: 'cancel' },
        {
          label: t(editing ? 'common.save' : 'billingPage.budgets.form.submit'),
          onPress: submit,
          loading: pending,
          disabled: pending,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <View className="gap-5 py-2">
        {editing ? (
          <Muted>{t('billingPage.budgets.form.fixedScope')}</Muted>
        ) : (
          <>
            <Field label={t('billingPage.budgets.form.appliesTo')}>
              <SegmentedControl
                type="radio"
                size="sm"
                label={t('billingPage.budgets.form.appliesTo')}
                value={scope}
                onValueChange={(next: string) => setScope(next as BudgetScope)}
              >
                {SCOPES.map((entry) => (
                  <SegmentedControlItem key={entry} value={entry}>
                    <SegmentedControlItemText>
                      {t(`billingPage.budgets.form.scopes.${entry}`)}
                    </SegmentedControlItemText>
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </Field>

            {scope !== 'account' ? (
              <Field
                label={t('billingPage.budgets.form.application')}
                description={
                  applications.length === 0
                    ? t('billingPage.budgets.form.noApplications')
                    : undefined
                }
              >
                <Select
                  value={applicationId}
                  onValueChange={(next) => {
                    setApplicationId(next);
                    setCredentialId('');
                  }}
                >
                  <SelectTrigger label={t('billingPage.budgets.form.application')}>
                    <SelectValue placeholder={t('billingPage.budgets.form.chooseApplication')} />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent
                    label={t('billingPage.budgets.form.application')}
                    items={applicationItems}
                    renderItem={(item) => (
                      <SelectItem value={item.value} label={item.label}>
                        <SelectItemIndicator />
                        <SelectItemText>{item.label}</SelectItemText>
                      </SelectItem>
                    )}
                  />
                </Select>
              </Field>
            ) : null}

            {scope === 'credential' && applicationId.length > 0 ? (
              <Field
                label={t('billingPage.budgets.form.credential')}
                description={
                  credentials.length === 0 && !credentialsQuery.isLoading
                    ? t('billingPage.budgets.form.noCredentials')
                    : undefined
                }
              >
                <Select value={credentialId} onValueChange={setCredentialId}>
                  <SelectTrigger label={t('billingPage.budgets.form.credential')}>
                    <SelectValue placeholder={t('billingPage.budgets.form.chooseCredential')} />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent
                    label={t('billingPage.budgets.form.credential')}
                    items={credentialItems}
                    renderItem={(item) => (
                      <SelectItem value={item.value} label={item.label}>
                        <SelectItemIndicator />
                        <SelectItemText>{item.label}</SelectItemText>
                      </SelectItem>
                    )}
                  />
                </Select>
              </Field>
            ) : null}

            <Field label={t('billingPage.budgets.form.period')}>
              <SegmentedControl
                type="radio"
                size="sm"
                label={t('billingPage.budgets.form.period')}
                value={period}
                onValueChange={(next: string) => setPeriod(next as BudgetPeriod)}
              >
                {BUDGET_PERIODS.map((entry) => (
                  <SegmentedControlItem key={entry} value={entry}>
                    <SegmentedControlItemText>
                      {t(`billingPage.budgets.periods.${entry}`)}
                    </SegmentedControlItemText>
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </Field>

            {currencies.length > 1 ? (
              <Field label={t('billingPage.budgets.form.currency')}>
                <SegmentedControl
                  type="radio"
                  size="sm"
                  label={t('billingPage.budgets.form.currency')}
                  value={currency}
                  onValueChange={setCurrency}
                >
                  {currencies.map((code) => (
                    <SegmentedControlItem key={code} value={code}>
                      <SegmentedControlItemText>{code}</SegmentedControlItemText>
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
              </Field>
            ) : null}
          </>
        )}

        <Field label={t('billingPage.budgets.form.ceiling')}>
          <TextFieldInput
            label={t('billingPage.budgets.form.ceiling')}
            value={limitAmount}
            inputMode="decimal"
            placeholder="250.00"
            onChangeText={setLimitAmount}
          />
        </Field>

        <Field label={t('billingPage.budgets.form.atCeiling')}>
          <SegmentedControl
            type="radio"
            size="sm"
            label={t('billingPage.budgets.form.atCeiling')}
            value={enforcement}
            onValueChange={(next: string) => setEnforcement(next as BudgetEnforcement)}
          >
            {BUDGET_ENFORCEMENTS.map((entry) => (
              <SegmentedControlItem key={entry} value={entry}>
                <SegmentedControlItemText>
                  {t(`billingPage.budgets.enforcement.${entry}`)}
                </SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Field>
        <Muted>{t(`billingPage.budgets.enforcementHint.${enforcement}`)}</Muted>

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

        {error !== null ? <Admonition type="error">{error}</Admonition> : null}
      </View>
    </Dialog>
  );
}
