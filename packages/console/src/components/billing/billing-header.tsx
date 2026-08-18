import { Link } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Clock01Icon,
  Coins01Icon,
  Money01Icon,
  Note01Icon,
  Target01Icon,
  Wallet01Icon,
} from '@hugeicons/core-free-icons';
import { cn } from '@/lib/utils';

/** The billing sections, in the order a customer needs them. */
export type BillingSection = 'overview' | 'spend' | 'charges' | 'budgets' | 'plans' | 'audit';

/**
 * Shared header for the billing pages: what account this is, and the sections.
 *
 * The sections are separate PAGES rather than tabs on one page, and money and
 * units never share one. `Spend` and `Charges` read the financial ledger;
 * `Usage` — reachable from the sidebar, deliberately outside this header — reads
 * telemetry. Keeping them on different screens is the strongest available form
 * of "do not let a usage number appear under a heading that implies it is what
 * they were charged": there is no heading either could drift under.
 */
export function BillingHeader({
  active,
  accountName,
  billingAccountName,
}: {
  active: BillingSection;
  accountName: string | undefined;
  /**
   * The account that actually pays, when it is not the one being viewed. A
   * project draws on the nearest ancestor holding a billing profile, and saying
   * so is the difference between "your balance" and somebody else's money shown
   * as though it were yours.
   */
  billingAccountName?: string;
}) {
  return (
    <div className="px-6 pt-6 border-b border-border">
      <h1 className="text-2xl font-semibold text-foreground">Billing</h1>
      <p className="text-sm text-muted-foreground mt-1">
        {accountName === undefined
          ? 'Balance, charges and budgets for the account you are working in.'
          : billingAccountName !== undefined
            ? `${accountName} spends ${billingAccountName}'s balance.`
            : `Balance, charges and budgets for ${accountName}.`}
      </p>

      <nav className="mt-6 flex flex-wrap items-center gap-1">
        <SectionTab
          to="/billing"
          icon={Wallet01Icon}
          label="Overview"
          isActive={active === 'overview'}
        />
        <SectionTab
          to="/billing/spend"
          icon={Money01Icon}
          label="Spend"
          isActive={active === 'spend'}
        />
        <SectionTab
          to="/billing/charges"
          icon={Clock01Icon}
          label="Holds and charges"
          isActive={active === 'charges'}
        />
        <SectionTab
          to="/billing/budgets"
          icon={Target01Icon}
          label="Budgets"
          isActive={active === 'budgets'}
        />
        <SectionTab
          to="/billing/plans"
          icon={Coins01Icon}
          label="Plans and credits"
          isActive={active === 'plans'}
        />
        {/*
          Changes to the balance, as opposed to movements within one. Last
          because it is the section a customer reaches for after reading the
          others — "why is this figure what it is".
        */}
        <SectionTab
          to="/billing/audit"
          icon={Note01Icon}
          label="Change history"
          isActive={active === 'audit'}
        />
      </nav>
    </div>
  );
}

interface SectionTabProps {
  to:
    | '/billing'
    | '/billing/spend'
    | '/billing/charges'
    | '/billing/budgets'
    | '/billing/plans'
    | '/billing/audit';
  icon: typeof Wallet01Icon;
  label: string;
  isActive: boolean;
}

function SectionTab({ to, icon, label, isActive }: SectionTabProps) {
  return (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-1.5 border-b-2 px-2 pb-2.5 -mb-px text-sm font-medium transition-colors',
        isActive
          ? 'border-foreground text-foreground'
          : 'border-transparent text-foreground/60 hover:text-foreground'
      )}
    >
      <HugeiconsIcon icon={icon} size={16} />
      {label}
    </Link>
  );
}
