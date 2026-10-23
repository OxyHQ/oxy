import { Chip } from '@oxy.so/bloom/chip';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import type { Job } from '@clarity.surf/sdk';

import { useTranslation } from '@/lib/i18n';

/** A Clarity job: its kind, status, page progress and id. */
export function JobSummary({ job }: { job: Job }) {
  const { t } = useTranslation();
  return (
    <GroupedSection separator="line">
      <GroupedSectionItem
        title={t('clarityPage.job.kind', { kind: job.kind })}
        value={t('clarityPage.job.progress', {
          done: job.pagesCompleted,
          total: job.pagesDiscovered,
        })}
        rightElement={<Chip size="sm">{job.status}</Chip>}
      />
      <GroupedSectionItem title={t('clarityPage.jobs.id')} value={job.id} />
    </GroupedSection>
  );
}
