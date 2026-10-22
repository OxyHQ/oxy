import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';

import { useTranslation } from '@/lib/i18n';

/** The answer for a member whose role does not carry `billing:read` on this account. */
export function NoBillingAccess() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={RiLockLine}
      title={t('reporting.denied.title')}
      description={t('reporting.denied.body')}
    />
  );
}
