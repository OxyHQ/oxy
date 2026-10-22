import { EmptyState } from '@oxy.so/bloom/empty-state';

import { useTranslation } from '@/lib/i18n';

/** A list that could not be fetched, with the reason and the way out. */
export function LoadFailed({ what }: { what: string }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      variant="compact"
      title={t('modelsPage.loadFailed.title', { what })}
      description={t('modelsPage.loadFailed.body')}
    />
  );
}
