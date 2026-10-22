import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { Dialog } from '@oxy.so/bloom/dialog';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';

import {
  type ApplicationCredential,
  type CredentialAuditEvent,
  useCredentialAudit,
} from '@/hooks/use-applications';
import {
  credentialAuditAttribution,
  credentialAuditVariant,
  humaniseAuditToken,
} from '@/lib/credential-audit';
import { useTranslation } from '@/lib/i18n';

/**
 * One credential's audit trail: created, rotated, revoked, and every refused
 * validation, in a side sheet.
 *
 * Nothing is projected away: the server's wire type has no `metadata` property
 * at all, so there is no blob to drop (see `useCredentialAudit`).
 *
 * `reason` and a null `actorUserId` are TWO CORRELATED STATES: a
 * `validation_failed` row is the only kind with a reason, and the only kind
 * with no actor, because a refused request did it. Attribution is therefore
 * rendered off `eventType` (`credentialAuditAttribution`), never off the
 * nullness of `actorUserId`.
 */
export function CredentialTrail({
  appId,
  credential,
  onClose,
}: {
  appId: string;
  credential: ApplicationCredential | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const {
    data: events = [],
    isLoading,
    isError,
    refetch,
  } = useCredentialAudit(appId, credential?._id, credential !== null);

  const columns = useMemo<ReadonlyArray<DataTableColumn<CredentialAuditEvent>>>(
    () => [
      {
        id: 'event',
        header: t('applications.credentials.trailEvent'),
        minWidth: 170,
        cell: ({ row }) => (
          <Badge
            content={humaniseAuditToken(row.eventType)}
            size="label-small"
            variant={credentialAuditVariant(row) === 'destructive' ? 'solid' : 'outlined'}
            color={credentialAuditVariant(row) === 'destructive' ? 'error' : 'default'}
          />
        ),
      },
      {
        id: 'detail',
        header: t('applications.credentials.trailDetail'),
        minWidth: 200,
        cell: ({ row }) => (
          <Text>
            {[
              row.reason !== null ? humaniseAuditToken(row.reason) : null,
              credentialAuditAttribution(row),
              row.environment ?? t('applications.credentials.noEnvironment'),
              row.effectiveUntil !== null
                ? t('applications.credentials.until', {
                    when: new Date(row.effectiveUntil).toLocaleString(),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        ),
      },
      {
        id: 'when',
        header: t('applications.credentials.trailWhen'),
        minWidth: 170,
        cell: ({ row }) => <Muted>{new Date(row.createdAt).toLocaleString()}</Muted>,
      },
    ],
    [t],
  );

  return (
    <Dialog
      open={credential !== null}
      onClose={onClose}
      placement={{ base: 'bottom', md: 'right' }}
      width={640}
      title={t('applications.credentials.trailTitle', { name: credential?.name ?? '' })}
      description={t('applications.credentials.trailBody')}
      actions={[{ label: t('common.close'), color: 'cancel' }]}
    >
      {isLoading ? (
        <Skeleton.Box width="100%" height={160} borderRadius={14} />
      ) : isError ? (
        <Admonition type="error">
          {t('applications.credentials.trailFailed')}{' '}
          <Button size="sm" appearance="plain" onPress={() => void refetch()}>
            {t('applications.retry')}
          </Button>
        </Admonition>
      ) : (
        <DataTable
          rows={events}
          columns={columns}
          getRowId={(row, index) => `${row.eventType}-${row.createdAt}-${index}`}
          accessibilityLabel={t('applications.credentials.trailTitle', {
            name: credential?.name ?? '',
          })}
          emptyState={t('applications.credentials.trailEmpty')}
          pageSize={10}
          minWidth={540}
        />
      )}
    </Dialog>
  );
}
