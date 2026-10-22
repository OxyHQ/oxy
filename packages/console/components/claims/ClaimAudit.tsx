import { Chip } from '@oxy.so/bloom/chip';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { Muted, Text } from '@oxy.so/bloom/typography';
import type { ContentClaimDetailView } from '@oxy.so/contracts';
import { useMemo } from 'react';

import { useTranslation } from '@/lib/i18n';

type ClaimEvent = ContentClaimDetailView['events'][number];

/** The claim's audit trail, oldest first as the API serves it. */
export function ClaimAudit({ events }: { events: ReadonlyArray<ClaimEvent> }) {
  const { t } = useTranslation();

  const columns = useMemo<Array<DataTableColumn<ClaimEvent>>>(
    () => [
      {
        id: 'when',
        header: t('claimsPage.audit.when'),
        basis: 180,
        cell: ({ row }) => <Muted>{new Date(row.createdAt).toLocaleString()}</Muted>,
      },
      {
        id: 'action',
        header: t('claimsPage.audit.action'),
        basis: 200,
        cell: ({ row }) => <Chip size="sm">{t(`claimsPage.events.${row.action}`)}</Chip>,
      },
      {
        id: 'transition',
        header: t('claimsPage.audit.transitionLabel'),
        basis: 200,
        cell: ({ row }) =>
          row.toState && row.fromState !== row.toState ? (
            <Text>
              {row.fromState
                ? t('claimsPage.audit.transition', {
                    from: t(`claimsPage.states.${row.fromState}`),
                    to: t(`claimsPage.states.${row.toState}`),
                  })
                : t(`claimsPage.states.${row.toState}`)}
            </Text>
          ) : null,
      },
      {
        id: 'actor',
        header: t('claimsPage.audit.actor'),
        basis: 180,
        cell: ({ row }) => (
          <Muted selectable>
            {row.actorUserId
              ? t('claimsPage.audit.byUser', { user: row.actorUserId })
              : t('claimsPage.audit.anonymous')}
          </Muted>
        ),
      },
      {
        id: 'note',
        header: t('claimsPage.audit.note'),
        basis: 320,
        cell: ({ row }) => (row.note ? <Text selectable>{row.note}</Text> : null),
      },
    ],
    [t],
  );

  return (
    <DataTable
      layout="inset"
      rows={events}
      columns={columns}
      getRowId={(event) => event.id}
      accessibilityLabel={t('claimsPage.sections.audit')}
      title={t('claimsPage.sections.audit')}
      pageSize={25}
      minWidth={900}
    />
  );
}
