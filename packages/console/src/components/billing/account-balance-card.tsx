import * as Skeleton from '@oxyhq/bloom/skeleton';
import type { LedgerBalanceBucket, LedgerBalanceResponse } from '@/lib/reporting';
import { Badge } from '@/components/ui/badge';
import { formatMoney } from '@/lib/money';
import { ProvenanceBadge } from '@/components/billing/provenance-banner';

/**
 * What the account holds, with the buckets kept apart.
 *
 * ## Why there is no total
 *
 * Purchased, promotional and reserved money are three different things and the
 * epic requires them distinct. Promotional credit may expire and is never
 * refundable; reserved money is HELD against requests currently in flight and
 * has not been spent. Adding them produces a figure that is wrong for every
 * question anyone asks of it — most damagingly "how much could I withdraw".
 *
 * `Available to spend` is offered BESIDE the three rather than instead of them.
 * It is the server's own derived headroom and answers exactly one question: will
 * the next request be refused.
 *
 * Every amount arrives as an exact decimal string and is formatted as a string
 * (`lib/money.ts`). Nothing on this screen goes through `Number()`.
 */
export function AccountBalanceCard({
  balance,
  isLoading,
}: {
  balance: LedgerBalanceResponse | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex flex-row flex-wrap gap-12">
        {[1, 2, 3, 4].map((index) => (
          <Skeleton.Box key={index} width={128} height={56} />
        ))}
      </div>
    );
  }

  if (balance === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        The balance for this account could not be loaded.
      </p>
    );
  }

  if (!balance.provisioned) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4">
        <p className="text-sm font-medium text-foreground">No billing profile yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Nobody has decided who pays for this account. That is not a balance of zero — until a
          profile exists, inference requests for this account have nothing to draw on.
        </p>
      </div>
    );
  }

  if (balance.balances.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This account has a billing profile and no balance in any currency yet.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {balance.balances.map((bucket) => (
        <CurrencyBalance
          key={bucket.currency}
          bucket={bucket}
          billingMode={balance.billingMode}
          creditLimit={balance.creditLimit}
        />
      ))}
    </div>
  );
}

function CurrencyBalance({
  bucket,
  billingMode,
  creditLimit,
}: {
  bucket: LedgerBalanceBucket;
  billingMode: 'prepaid' | 'invoiced' | undefined;
  creditLimit: string | undefined;
}) {
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-foreground">{bucket.currency}</p>
        {billingMode !== undefined && (
          <Badge variant="secondary">{billingMode === 'prepaid' ? 'Prepaid' : 'Invoiced'}</Badge>
        )}
        <ProvenanceBadge provenance={{ source: 'financial_ledger', consistency: 'authoritative' }} />
      </div>

      <div className="flex flex-row flex-wrap gap-12">
        <BalanceFigure
          label="Purchased"
          hint="Money you bought and have not spent."
          amount={bucket.purchased}
          currency={bucket.currency}
        />
        <BalanceFigure
          label="Promotional"
          hint="Granted credit. Spent first, may expire, never refundable."
          amount={bucket.promotional}
          currency={bucket.currency}
        />
        <BalanceFigure
          label="Reserved"
          hint="Held against requests in flight. Not spent."
          amount={bucket.reserved}
          currency={bucket.currency}
        />
        <BalanceFigure
          label="Available to spend"
          hint="Derived headroom, not a fourth pot of money."
          amount={bucket.availableToSpend}
          currency={bucket.currency}
        />
      </div>

      {billingMode === 'invoiced' && (
        <div className="mt-6 flex flex-row flex-wrap gap-12">
          <BalanceFigure
            label="Invoiced outstanding"
            hint="Drawn against the credit line and not yet paid."
            amount={bucket.invoicedOutstanding}
            currency={bucket.currency}
          />
          {creditLimit !== undefined && (
            <BalanceFigure
              label="Credit limit"
              hint="How far this account may draw before a request is refused."
              amount={creditLimit}
              currency={bucket.currency}
            />
          )}
        </div>
      )}
    </div>
  );
}

function BalanceFigure({
  label,
  hint,
  amount,
  currency,
}: {
  label: string;
  hint: string;
  amount: string;
  currency: string;
}) {
  return (
    <div className="min-w-40">
      <p className="text-2xl font-semibold text-foreground tabular-nums">
        {formatMoney(amount, currency)}
      </p>
      <p className="mt-0.5 text-sm text-foreground">{label}</p>
      <p className="mt-0.5 text-xs text-muted-foreground max-w-56">{hint}</p>
    </div>
  );
}
