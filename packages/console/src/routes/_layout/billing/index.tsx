import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { toast } from '@oxyhq/bloom/toast';
import { exactDecimalSchema } from '@oxyhq/contracts';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BillingHeader } from '@/components/billing/billing-header';
import { AccountBalanceCard } from '@/components/billing/account-balance-card';
import { ProvenanceBanner } from '@/components/billing/provenance-banner';
import { accountLabel, useAccount } from '@/hooks/use-account';
import {
  useAccountBillingPortal,
  useAccountBillingState,
  useAccountInvoices,
  useAccountTopUpCheckout,
  useAutoRechargeAttempts,
  useProvisionAccountBilling,
  useUpdateAutoRecharge,
} from '@/hooks/use-account-billing';
import { useLedgerBalance } from '@/hooks/use-inference-reporting';
import { formatMoney } from '@/lib/money';
import { getErrorMessage } from '@/lib/api-error';

/**
 * The account's balance and billing profile.
 *
 * Everything on this page is ACCOUNT-scoped: the balance belongs to the account
 * being worked in, not to the signed-in user, and when that account merely
 * inherits a profile the header says whose money it is spending. Product plans
 * and their credits are a different unit and live on their own page.
 *
 * Both reads that produce money here — the ledger balance and the billing
 * profile — are stamped `financial_ledger` / `authoritative` by the API, and the
 * banner takes that stamp off the response rather than from a prop.
 */
export const Route = createFileRoute('/_layout/billing/')({
  component: BillingOverviewPage,
});

function BillingOverviewPage() {
  const { accounts, currentAccount, canReadBilling, canManageBilling } = useAccount();
  const accountId = currentAccount?.accountId;
  const canRead = currentAccount !== null && canReadBilling(currentAccount);
  const canManage = currentAccount !== null && canManageBilling(currentAccount);

  const balanceQuery = useLedgerBalance(accountId, canRead);
  const stateQuery = useAccountBillingState(accountId, canRead);
  const invoicesQuery = useAccountInvoices(accountId, canRead);
  const attemptsQuery = useAutoRechargeAttempts(accountId, canRead);

  const provision = useProvisionAccountBilling();
  const checkout = useAccountTopUpCheckout();
  const portal = useAccountBillingPortal();
  const updateAutoRecharge = useUpdateAutoRecharge();

  const [showTopUp, setShowTopUp] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpError, setTopUpError] = useState<string | null>(null);

  const state = stateQuery.data ?? null;
  const payer =
    state !== null && state.inherited
      ? accounts.find((node) => node.accountId === state.billingAccountId)
      : undefined;

  const handleProvision = async () => {
    if (accountId === undefined) {
      return;
    }
    try {
      await provision.mutateAsync({ accountId });
      toast.success('This account now has a billing profile of its own.');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Could not create a billing profile'));
    }
  };

  const handleTopUp = async () => {
    if (accountId === undefined) {
      return;
    }
    // Parsed with the contract's own schema — the same one the ledger's NUMERIC
    // columns are declared against — so an amount that would become a float is
    // refused here rather than after the card is charged.
    const amount = exactDecimalSchema.safeParse(topUpAmount.trim());
    if (!amount.success) {
      setTopUpError('Enter an exact amount — digits and at most one point, no exponent.');
      return;
    }
    if (/^0+(\.0*)?$/.test(topUpAmount.trim())) {
      setTopUpError('A top-up of zero would charge nothing.');
      return;
    }
    setTopUpError(null);
    try {
      const result = await checkout.mutateAsync({
        accountId,
        amount: amount.data,
        successUrl: `${window.location.origin}/billing?topup=success`,
        cancelUrl: `${window.location.origin}/billing?topup=canceled`,
      });
      window.location.href = result.url;
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Could not start the top-up'));
    }
  };

  const handlePortal = async () => {
    if (accountId === undefined) {
      return;
    }
    try {
      const url = await portal.mutateAsync({
        accountId,
        returnUrl: `${window.location.origin}/billing`,
      });
      window.location.href = url;
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Could not open the billing portal'));
    }
  };

  const handleDisableAutoRecharge = async () => {
    if (accountId === undefined) {
      return;
    }
    try {
      await updateAutoRecharge.mutateAsync({ accountId, autoRecharge: { enabled: false } });
      toast.success('Automatic top-ups are off.');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Could not change automatic top-ups'));
    }
  };

  return (
    <ScrollArea className="flex-1 bg-background">
      <BillingHeader
        active="overview"
        accountName={currentAccount === null ? undefined : accountLabel(currentAccount)}
        billingAccountName={payer === undefined ? undefined : accountLabel(payer)}
      />

      {!canRead ? (
        <div className="px-6 py-12 text-center text-sm text-muted-foreground">
          You do not have permission to see this account's billing.
        </div>
      ) : (
        <>
          <div className="px-6 py-6 border-b border-border">
            <ProvenanceBanner
              provenance={{ source: 'financial_ledger', consistency: 'authoritative' }}
            />
          </div>

          {/* Balance */}
          <div className="px-6 py-6 border-b border-border">
            <p className="text-sm font-semibold text-foreground mb-4">Balance</p>
            <AccountBalanceCard balance={balanceQuery.data} isLoading={balanceQuery.isLoading} />

            {balanceQuery.data?.provisioned === false && canManage && (
              <Button
                className="mt-4"
                variant="outline"
                size="sm"
                onClick={handleProvision}
                disabled={provision.isPending}
              >
                {provision.isPending ? 'Creating...' : 'Create a billing profile'}
              </Button>
            )}
          </div>

          {/* Profile */}
          <div className="px-6 py-6 border-b border-border">
            <p className="text-sm font-semibold text-foreground mb-4">Billing profile</p>
            {stateQuery.isLoading ? (
              <Skeleton.Box width="100%" height={72} />
            ) : state === null ? (
              <p className="text-sm text-muted-foreground">
                No profile of this account's own, and no ancestor holding one.
              </p>
            ) : (
              <dl className="grid gap-x-12 gap-y-3 sm:grid-cols-2 max-w-2xl">
                <ProfileRow label="Paid by" value={payer === undefined ? 'This account' : accountLabel(payer)} />
                <ProfileRow
                  label="Mode"
                  value={state.profile.billingMode === 'prepaid' ? 'Prepaid' : 'Invoiced'}
                />
                <ProfileRow label="Currency" value={state.profile.currency} />
                <ProfileRow
                  label="Status"
                  value={
                    <Badge variant={state.profile.status === 'active' ? 'default' : 'secondary'}>
                      {state.profile.status}
                    </Badge>
                  }
                />
                <ProfileRow
                  label="Automatic top-ups"
                  value={
                    state.profile.autoRecharge.enabled &&
                    state.profile.autoRecharge.threshold !== undefined &&
                    state.profile.autoRecharge.amount !== undefined
                      ? `Add ${formatMoney(state.profile.autoRecharge.amount, state.profile.currency)} when the balance falls below ${formatMoney(state.profile.autoRecharge.threshold, state.profile.currency)}`
                      : 'Off'
                  }
                />
                {state.profile.billingMode === 'invoiced' && (
                  <ProfileRow
                    label="Credit limit"
                    value={formatMoney(state.profile.creditLimit, state.profile.currency)}
                  />
                )}
              </dl>
            )}

            {canManage && state !== null && state.profile.autoRecharge.enabled && (
              <Button
                className="mt-4"
                variant="outline"
                size="sm"
                onClick={handleDisableAutoRecharge}
                disabled={updateAutoRecharge.isPending}
              >
                Turn off automatic top-ups
              </Button>
            )}
            {canManage && (
              <p className="mt-4 text-xs text-muted-foreground max-w-2xl">
                Billing mode and credit limit are set by Oxy, not from here — an account that could
                grant itself invoiced mode with a credit limit would be issuing itself credit.
              </p>
            )}
          </div>

          {/* Money in */}
          <div className="px-6 py-6 border-b border-border">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Payment methods and invoices</p>
                <p className="mt-0.5 text-sm text-muted-foreground max-w-xl">
                  Cards and receipts are maintained in the payment provider's portal. A top-up is
                  credited when the provider confirms the charge, never when the checkout opens.
                </p>
              </div>
              {canManage && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowTopUp(true)}>
                    Add funds
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePortal}
                    disabled={portal.isPending}
                  >
                    {portal.isPending ? 'Opening...' : 'Open billing portal'}
                  </Button>
                </div>
              )}
            </div>

            <div className="mt-6">
              <p className="text-sm font-medium text-foreground mb-3">Invoices</p>
              {invoicesQuery.isLoading ? (
                <Skeleton.Box width="100%" height={48} />
              ) : (invoicesQuery.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No invoices yet. A prepaid account settles at request time and is not invoiced in
                  arrears.
                </p>
              ) : (
                <div className="divide-y divide-border rounded-lg border border-border">
                  {(invoicesQuery.data ?? []).map((invoice) => (
                    <div
                      key={invoice.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">
                          {new Date(invoice.periodStart).toLocaleDateString()} –{' '}
                          {new Date(invoice.periodEnd).toLocaleDateString()}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {invoice.receiptCount.toLocaleString()} charges
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-foreground tabular-nums">
                          {formatMoney(invoice.totalAmount, invoice.currency)}
                        </span>
                        <Badge variant={invoice.status === 'paid' ? 'default' : 'secondary'}>
                          {invoice.status}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Automatic top-ups */}
          <div className="px-6 py-6">
            <p className="text-sm font-semibold text-foreground mb-4">Recent automatic top-ups</p>
            {attemptsQuery.isLoading ? (
              <Skeleton.Box width="100%" height={48} />
            ) : (attemptsQuery.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No automatic top-ups have been tried.</p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {(attemptsQuery.data ?? []).map((attempt) => (
                  <div
                    key={attempt.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground tabular-nums">
                        {formatMoney(attempt.requestedAmount, attempt.currency)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Triggered at {formatMoney(attempt.balanceAtTrigger, attempt.currency)} ·{' '}
                        {new Date(attempt.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {attempt.failureCode !== undefined && (
                        <span className="text-xs text-muted-foreground font-mono">
                          {attempt.failureCode}
                        </span>
                      )}
                      <Badge
                        variant={
                          attempt.status === 'succeeded'
                            ? 'default'
                            : attempt.status === 'failed'
                              ? 'destructive'
                              : 'secondary'
                        }
                      >
                        {attempt.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <Dialog open={showTopUp} onOpenChange={setShowTopUp}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add funds</DialogTitle>
            <DialogDescription>
              The balance moves when the payment provider confirms the charge, not when this
              checkout opens. The amount is charged in the account's own currency
              {state === null ? '' : ` (${state.profile.currency})`}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="top-up-amount">Amount</Label>
            <Input
              id="top-up-amount"
              value={topUpAmount}
              inputMode="decimal"
              placeholder="50.00"
              onChange={(event) => setTopUpAmount(event.target.value)}
            />
            {topUpError !== null && <p className="text-sm text-destructive">{topUpError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTopUp(false)}>
              Cancel
            </Button>
            <Button onClick={handleTopUp} disabled={checkout.isPending}>
              {checkout.isPending ? 'Opening...' : 'Continue to payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  );
}

function ProfileRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground text-right">{value}</dd>
    </div>
  );
}
