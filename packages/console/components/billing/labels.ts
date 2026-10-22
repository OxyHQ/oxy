import { useMemo } from 'react';
import type { AccountAuditSource } from '@/hooks/use-account-audit';
import type { BillingAuditActorKind, BillingAuditKind } from '@/hooks/use-account-audit';
import type {
  Budget,
  BudgetEnforcement,
  BudgetPeriod,
  ReportProvenance,
  SpendDimension,
  UsageDimension,
} from '@/lib/reporting';
import { useTranslation } from '@/lib/i18n';

/** The badge vocabulary the console's lib helpers speak (`budgetUtilizationVariant`, ...). */
export type StatusVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost';

const STATUS_PAINT = {
  default: { tone: 'neutral', appearance: 'solid' },
  secondary: { tone: 'neutral', appearance: 'subtle' },
  destructive: { tone: 'danger', appearance: 'subtle' },
  outline: { tone: 'neutral', appearance: 'outline' },
  ghost: { tone: 'neutral', appearance: 'plain' },
} as const;

/** Bloom `Badge` props for a lib status variant: `<Badge content={label} {...statusBadge(v)} />`. */
export function statusBadge(variant: StatusVariant = 'secondary') {
  return { ...STATUS_PAINT[variant], size: 'label-small' } as const;
}

/**
 * The strings `lib/reporting.ts`, `lib/billing-audit.ts` and `lib/account-audit.ts`
 * return in English, resolved through the dictionary instead. The libs stay
 * UI-free and keep their own tests; this is the only place the two meet.
 */
export function useReportLabels() {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      dimension: (dimension: UsageDimension | SpendDimension): string =>
        t(`reportKit.dimensions.${dimension}`),
      period: (period: BudgetPeriod): string => t(`reportKit.periods.${period}`),
      enforcement: (enforcement: BudgetEnforcement): string =>
        t(`reportKit.enforcement.${enforcement}`),
      scope: (budget: Budget): string => {
        switch (budget.scope) {
          case 'account':
            return t('reportKit.scope.account', { id: budget.scopeAccountId ?? budget.accountId });
          case 'application':
            return t('reportKit.scope.application', { id: budget.scopeApplicationId ?? '' });
          case 'credential':
            return t('reportKit.scope.credential', {
              id: budget.scopeApplicationCredentialId ?? '',
            });
        }
      },
      provenanceHeadline: (provenance: ReportProvenance): string =>
        t(
          provenance.source === 'financial_ledger'
            ? 'reportKit.provenance.ledgerHeadline'
            : 'reportKit.provenance.telemetryHeadline',
        ),
      provenanceExplanation: (provenance: ReportProvenance): string =>
        t(
          provenance.source === 'financial_ledger'
            ? 'reportKit.provenance.ledgerExplanation'
            : 'reportKit.provenance.telemetryExplanation',
        ),
      billingKind: (kind: BillingAuditKind): string => t(`billingPage.audit.kinds.${kind}`),
      billingActor: (actorKind: BillingAuditActorKind): string =>
        t(`billingPage.audit.actors.${actorKind}`),
      billingDirection: (direction: 'in' | 'out' | 'none'): string =>
        t(`billingPage.audit.directions.${direction}`),
      billingReference: (label: string): string => t(`billingPage.audit.references.${label}`),
      auditActor: (kind: 'user' | 'service' | 'platform' | 'none' | 'unknown'): string =>
        t(`settingsPage.audit.actors.${kind}`),
      auditSource: (source: AccountAuditSource): string =>
        t(`settingsPage.audit.sources.${source}`),
    }),
    [t],
  );
}
