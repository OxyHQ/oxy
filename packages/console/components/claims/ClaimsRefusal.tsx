import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';

import { useTranslation } from '@/lib/i18n';

/** What someone without the `content:claims` capability sees, instead of a spinner. */
export function ClaimsRefusal() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={RiLockLine}
      title={t('claimsPage.refusalTitle')}
      description={t('claimsPage.refusal')}
    />
  );
}
