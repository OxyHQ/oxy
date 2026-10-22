import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import { Screen } from '@oxy.so/bloom/screen';

import { useTranslation } from '@/lib/i18n';

/** `/apps` with nothing selected: the detail panel invites a choice from the list. */
export default function AppsIndexScreen() {
  const { t } = useTranslation();
  return (
    <Screen>
      <EmptyState
        icon={RiBox3Line}
        title={t('applications.selectTitle')}
        description={t('applications.selectBody')}
      />
    </Screen>
  );
}
