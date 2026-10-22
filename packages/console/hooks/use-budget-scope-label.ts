import { useCallback } from 'react';
import { useApplicationNames } from '@/hooks/use-application-names';
import { useTranslation } from '@/lib/i18n';
import type { Budget } from '@/lib/reporting';

/** What a budget applies to, in words: the account, an application by name, a credential. */
export function useBudgetScopeLabel(): (budget: Budget) => string {
  const { t } = useTranslation();
  const applicationName = useApplicationNames();

  return useCallback(
    (budget) => {
      switch (budget.scope) {
        case 'account':
          return t('billingPage.budgets.scope.account');
        case 'application':
          return t('billingPage.budgets.scope.application', {
            name: applicationName(budget.scopeApplicationId ?? ''),
          });
        case 'credential':
          return t('billingPage.budgets.scope.credential', {
            id: budget.scopeApplicationCredentialId ?? '',
          });
      }
    },
    [applicationName, t],
  );
}
