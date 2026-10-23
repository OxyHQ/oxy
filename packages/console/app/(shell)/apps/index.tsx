import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import { Screen } from '@oxy.so/bloom/screen';

import { useApplications } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';

/** `/apps` with nothing selected: the detail panel invites a choice from the list. */
export default function AppsIndexScreen() {
  const { t } = useTranslation();
  const { data: applications = [] } = useApplications();
  // With no applications the list already carries the empty state and its action;
  // asking to "select" one here would contradict it.
  const none = applications.every((app) => app.status === 'deleted');
  return (
    <Screen>
      <EmptyState
        icon={RiBox3Line}
        title={none ? t('applications.detailEmptyTitle') : t('applications.selectTitle')}
        description={none ? t('applications.detailEmptyBody') : t('applications.selectBody')}
      />
    </Screen>
  );
}
