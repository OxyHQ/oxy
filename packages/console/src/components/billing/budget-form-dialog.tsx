import { useState } from 'react';
import { currencyCodeSchema, exactDecimalSchema } from '@oxyhq/contracts';
import type {
  BudgetEnforcement,
  BudgetPeriod,
  BudgetScope,
} from '@/lib/reporting';
import type { CreateBudgetInput } from '@/hooks/use-inference-reporting';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatBasisPoints } from '@/lib/money';
import {
  BUDGET_ALERT_THRESHOLDS_BPS,
  BUDGET_ENFORCEMENTS,
  BUDGET_PERIODS,
  budgetEnforcementLabel,
  budgetPeriodLabel,
} from '@/lib/reporting';
import { useApplicationCredentials, useApplications } from '@/hooks/use-applications';

/**
 * Create a budget against the account's spend.
 *
 * Three properties are structural rather than validated after the fact:
 *
 *  - **The scope and its target cannot disagree.** {@link CreateBudgetInput} is
 *    a discriminated union mirroring the API's own body schema, so "scope says
 *    application, body names an account" is unbuildable rather than a 400 after
 *    the form is filled in.
 *  - **The ceiling is exact.** It is edited as text and parsed with
 *    `exactDecimalSchema` — the contract's own schema, the same one the ledger's
 *    NUMERIC columns are declared against — so a value that would become a float
 *    is refused here with the field named. Nothing in this file calls `Number()`
 *    on an amount.
 *  - **Alert thresholds come from the closed set** the column's CHECK admits.
 *    A free-form percentage would be accepted by the form and rejected by the
 *    database.
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
  const [scope, setScope] = useState<BudgetScope>(
    fixedApplicationId === undefined ? 'account' : 'application'
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

  const handleSubmit = () => {
    const amount = exactDecimalSchema.safeParse(limitAmount.trim());
    if (!amount.success) {
      setError(
        'The ceiling must be an exact decimal amount — digits and at most one point, no exponent.'
      );
      return;
    }
    // A string test, not a numeric one: `0`, `0.00` and `0.000000000000` are the
    // same amount, and none of them is a usable ceiling.
    if (/^0+(\.0*)?$/.test(limitAmount.trim())) {
      setError('A ceiling of zero refuses every request. Disable the budget instead.');
      return;
    }

    let resolvedCurrency: string | undefined;
    if (currency.length > 0) {
      const parsed = currencyCodeSchema.safeParse(currency);
      if (!parsed.success) {
        setError('The currency must be an ISO 4217 alpha-3 code, for example USD.');
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
        setError('Choose the application this budget applies to.');
        return;
      }
      setError(null);
      onSubmit({ ...common, scope: 'application', scopeApplicationId: applicationId });
      return;
    }

    if (scope === 'credential') {
      if (credentialId.length === 0) {
        setError('Choose the credential this budget applies to.');
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
        : BUDGET_ALERT_THRESHOLDS_BPS.filter(
            (entry) => entry === bps || current.includes(entry)
          )
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New budget</DialogTitle>
          <DialogDescription>
            A budget is a ceiling on spend, never a pot of money. Raising, lowering or disabling one
            moves nothing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {fixedApplicationId === undefined && (
            <div className="space-y-2">
              <Label>Applies to</Label>
              <Select value={scope} onValueChange={(value) => setScope(value as BudgetScope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="account">This account and everything under it</SelectItem>
                  <SelectItem value="application">One application</SelectItem>
                  <SelectItem value="credential">One credential</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {fixedApplicationId === undefined && scope !== 'account' && (
            <div className="space-y-2">
              <Label>Application</Label>
              <Select
                value={applicationId}
                onValueChange={(value) => {
                  setApplicationId(value);
                  setCredentialId('');
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose an application" />
                </SelectTrigger>
                <SelectContent>
                  {applications.map((application) => (
                    <SelectItem key={application._id} value={application._id}>
                      {application.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {applications.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  This account owns no applications yet.
                </p>
              )}
            </div>
          )}

          {scope === 'credential' && applicationId.length > 0 && (
            <div className="space-y-2">
              <Label>Credential</Label>
              <Select value={credentialId} onValueChange={setCredentialId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a credential" />
                </SelectTrigger>
                <SelectContent>
                  {credentials.map((credential) => (
                    <SelectItem key={credential._id} value={credential._id}>
                      {credential.name} · {credential.environment}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {credentials.length === 0 && !credentialsQuery.isLoading && (
                <p className="text-xs text-muted-foreground">
                  This application has no credentials yet.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Period</Label>
              <Select value={period} onValueChange={(value) => setPeriod(value as BudgetPeriod)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BUDGET_PERIODS.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {budgetPeriodLabel(entry)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="budget-limit">Ceiling</Label>
              <Input
                id="budget-limit"
                value={limitAmount}
                inputMode="decimal"
                placeholder="250.00"
                onChange={(event) => setLimitAmount(event.target.value)}
              />
            </div>
          </div>

          {currencies.length > 0 && (
            <div className="space-y-2">
              <Label>Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label>At the ceiling</Label>
            <Select
              value={enforcement}
              onValueChange={(value) => setEnforcement(value as BudgetEnforcement)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUDGET_ENFORCEMENTS.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {budgetEnforcementLabel(entry)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Alert at</Label>
            <div className="flex flex-wrap gap-1.5">
              {BUDGET_ALERT_THRESHOLDS_BPS.map((bps) => {
                const isSelected = thresholds.includes(bps);
                return (
                  <button
                    key={bps}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => toggleThreshold(bps)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                      isSelected
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {formatBasisPoints(bps)}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Each threshold is recorded once per period, so an alert does not re-fire on every
              request for the rest of the month.
            </p>
          </div>

          {error !== null && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? 'Creating...' : 'Create budget'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
