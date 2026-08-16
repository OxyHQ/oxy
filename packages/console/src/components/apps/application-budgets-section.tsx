import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { toast } from '@oxyhq/bloom/toast';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import type { CreateBudgetInput } from '@/hooks/use-inference-reporting';
import type { Budget } from '@/lib/reporting';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ProvenanceBanner } from '@/components/billing/provenance-banner';
import { BudgetFormDialog } from '@/components/billing/budget-form-dialog';
import { useApplicationCredentials } from '@/hooks/use-applications';
import {
  useBudgets,
  useCreateBudget,
  useLedgerBalance,
  useUpdateBudget,
} from '@/hooks/use-inference-reporting';
import { formatBasisPoints, formatMoney } from '@/lib/money';
import { getErrorMessage } from '@/lib/api-error';
import {
  budgetEnforcementLabel,
  budgetPeriodLabel,
  budgetUtilizationVariant,
} from '@/lib/reporting';

const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

/**
 * The budgets that can refuse THIS application's traffic.
 *
 * ## Three kinds bind an application, not one
 *
 * A budget scoped to the application itself, a budget scoped to one of its
 * credentials, and the owning account's own budget — which bounds everything
 * underneath it — all take effect here. Showing only the first would answer "no
 * budgets" to an application that is one request away from a hard stop, which is
 * the failure this section exists to prevent.
 *
 * The account-scoped ones are marked as inherited rather than merged in, because
 * they are not this application's to raise: an account budget belongs to the
 * account, and editing it from here would change every sibling application's
 * ceiling at the same time.
 */
export function ApplicationBudgetsSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const canRead = access.can('billing:read');
  const canManage = access.can('billing:manage');

  const budgetsQuery = useBudgets(application.ownerAccountId, canRead);
  const balanceQuery = useLedgerBalance(application.ownerAccountId, canRead);
  const credentialsQuery = useApplicationCredentials(
    application._id,
    canRead && access.can('credentials:read')
  );
  const createBudget = useCreateBudget();
  const updateBudget = useUpdateBudget();

  const [showForm, setShowForm] = useState(false);

  const credentialIds = useMemo(
    () => new Set((credentialsQuery.data ?? []).map((credential) => credential._id)),
    [credentialsQuery.data]
  );

  const { own, inherited } = useMemo(() => {
    const rows = budgetsQuery.data?.rows ?? [];
    return {
      own: rows.filter(
        (budget) =>
          budget.scopeApplicationId === application._id ||
          (budget.scopeApplicationCredentialId !== undefined &&
            credentialIds.has(budget.scopeApplicationCredentialId))
      ),
      inherited: rows.filter((budget) => budget.scope === 'account'),
    };
  }, [budgetsQuery.data, application._id, credentialIds]);

  const currencies = (balanceQuery.data?.balances ?? []).map((bucket) => bucket.currency);

  const handleCreate = async (input: CreateBudgetInput) => {
    try {
      await createBudget.mutateAsync({ accountId: application.ownerAccountId, input });
      setShowForm(false);
      toast.success('Budget created.');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Could not create the budget'));
    }
  };

  const handleToggle = async (budget: Budget) => {
    const next = budget.status === 'active' ? 'disabled' : 'active';
    try {
      await updateBudget.mutateAsync({
        accountId: application.ownerAccountId,
        budgetId: budget.spendingLimitId,
        input: { status: next },
      });
      toast.success(next === 'active' ? 'Budget re-armed.' : 'Budget disabled.');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Could not change the budget'));
    }
  };

  if (!canRead) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        You do not have permission to view this application's budgets.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Limits and budgets</h2>
          <p className="text-sm text-muted-foreground">
            Ceilings evaluated before a request runs. A hard stop refuses it; a soft stop lets it
            through and records the crossing.
          </p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setShowForm(true)}>
            New budget
          </Button>
        )}
      </div>

      <ProvenanceBanner provenance={LEDGER} />

      <section className="space-y-3">
        <p className="text-sm font-medium text-foreground">This application</p>
        {budgetsQuery.isLoading ? (
          <Skeleton.Box width="100%" height={96} />
        ) : own.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No budget names this application or one of its credentials.
          </p>
        ) : (
          own.map((budget) => (
            <BudgetRow
              key={budget.spendingLimitId}
              budget={budget}
              canManage={canManage}
              isPending={updateBudget.isPending}
              onToggle={handleToggle}
            />
          ))
        )}
      </section>

      <section className="space-y-3">
        <p className="text-sm font-medium text-foreground">Inherited from the account</p>
        {budgetsQuery.isLoading ? (
          <Skeleton.Box width="100%" height={96} />
        ) : inherited.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The owning account has no budget of its own.
          </p>
        ) : (
          <>
            {inherited.map((budget) => (
              <BudgetRow key={budget.spendingLimitId} budget={budget} canManage={false} isPending={false} onToggle={handleToggle} />
            ))}
            <p className="text-xs text-muted-foreground">
              These bound every application under the account. Change them in{' '}
              <Link to="/billing/budgets" className="underline underline-offset-4">
                Billing → Budgets
              </Link>
              , where the effect on sibling applications is visible.
            </p>
          </>
        )}
      </section>

      <BudgetFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        accountId={application.ownerAccountId}
        currencies={currencies}
        fixedApplicationId={application._id}
        isPending={createBudget.isPending}
        onSubmit={handleCreate}
      />
    </div>
  );
}

function BudgetRow({
  budget,
  canManage,
  isPending,
  onToggle,
}: {
  budget: Budget;
  canManage: boolean;
  isPending: boolean;
  onToggle: (budget: Budget) => void;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">
              {budgetPeriodLabel(budget.period)} · {formatMoney(budget.limitAmount, budget.currency)}
            </p>
            <Badge variant={budgetUtilizationVariant(budget)}>
              {budget.status === 'disabled'
                ? 'Disabled'
                : `${formatBasisPoints(budget.utilizationBps)} used`}
            </Badge>
            {budget.scope === 'credential' && <Badge variant="outline">credential</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {budgetEnforcementLabel(budget.enforcement)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            {formatMoney(budget.currentSpend, budget.currency)} spent ·{' '}
            {formatMoney(budget.remaining, budget.currency)} remaining
          </p>
        </div>
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => onToggle(budget)} disabled={isPending}>
            {budget.status === 'active' ? 'Disable' : 'Re-arm'}
          </Button>
        )}
      </div>
    </div>
  );
}
