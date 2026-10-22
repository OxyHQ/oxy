import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { DataTable, DataTableRowActions, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import type { Application, ApplicationCredential, CallerAccess } from '@/hooks/use-applications';
import {
  useApplicationCredentials,
  useRevokeCredential,
  useRotateCredential,
} from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import { copyText } from '@/lib/clipboard';
import { useTranslation } from '@/lib/i18n';
import { CreateCredentialDialog } from './CreateCredentialDialog';
import { CredentialTrail } from './CredentialTrail';
import { RevealedSecret, type RevealedSecretValue } from './RevealedSecret';

/**
 * The application's credentials: public, confidential, service and API-key
 * (machine) clients across environments, with create, rotate, revoke and each
 * credential's audit trail. The show-once secret lands above the table.
 */
export function CredentialsTable({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const appId = application._id;
  const canRead = access.can('credentials:read');
  const canCreate = access.can('credentials:create');
  const canRotate = access.can('credentials:rotate');
  const canRevoke = access.can('credentials:revoke');

  const {
    data: credentials = [],
    isLoading,
    isError,
    refetch,
  } = useApplicationCredentials(appId, canRead);
  const rotateCredential = useRotateCredential();
  const revokeCredential = useRevokeCredential();

  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<RevealedSecretValue | null>(null);
  const [trailFor, setTrailFor] = useState<ApplicationCredential | null>(null);
  const [toRotate, setToRotate] = useState<ApplicationCredential | null>(null);
  const [toRevoke, setToRevoke] = useState<ApplicationCredential | null>(null);

  const reveal = ({
    credential,
    secret,
    token,
  }: {
    credential: ApplicationCredential;
    secret: string | null;
    token?: string;
  }) =>
    setRevealed({
      credentialName: credential.name,
      publicKey: credential.publicKey,
      secret,
      token,
    });

  const handleRotate = async () => {
    if (!toRotate) return;
    try {
      reveal(await rotateCredential.mutateAsync({ appId, credentialId: toRotate._id }));
      setToRotate(null);
      toast.success(t('applications.credentials.rotated'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.credentials.rotateFailed')));
    }
  };

  const handleRevoke = async () => {
    if (!toRevoke) return;
    try {
      await revokeCredential.mutateAsync({ appId, credentialId: toRevoke._id });
      setToRevoke(null);
      toast.success(t('applications.credentials.revoked'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.credentials.revokeFailed')));
    }
  };

  const columns = useMemo<ReadonlyArray<DataTableColumn<ApplicationCredential>>>(
    () => [
      {
        id: 'name',
        header: t('applications.credentials.name'),
        accessor: (row) => row.name,
        minWidth: 220,
        flex: 2,
        cell: ({ row }) => (
          <View className="min-w-0 gap-0.5">
            <Text numberOfLines={1}>{row.name}</Text>
            {/* For an API key the identifier a developer recognises is its `oxy_sk_`
                prefix, not the OAuth client id it also carries. Both are public;
                neither is the key. */}
            <Muted className="font-mono text-xs" numberOfLines={1}>
              {row.tokenPrefix ?? row.publicKey}
            </Muted>
          </View>
        ),
      },
      {
        id: 'type',
        header: t('applications.credentials.type'),
        accessor: (row) => row.type,
        width: 130,
        cell: ({ row }) => (
          <Badge
            content={t(`applications.credentials.types.${row.type}`)}
            size="label-small"
            variant="outlined"
            color="default"
          />
        ),
      },
      {
        id: 'environment',
        header: t('applications.credentials.environment'),
        accessor: (row) => row.environment,
        width: 130,
        cell: ({ row }) => (
          <Muted>{t(`applications.credentials.environments.${row.environment}`)}</Muted>
        ),
      },
      {
        id: 'status',
        header: t('applications.credentials.status'),
        accessor: (row) => row.status,
        width: 110,
        cell: ({ row }) => (
          <Badge
            content={row.status}
            size="label-small"
            variant={row.status === 'active' ? 'solid' : 'subtle'}
            color={
              row.status === 'active' ? 'success' : row.status === 'revoked' ? 'error' : 'default'
            }
          />
        ),
      },
      {
        id: 'lastUsed',
        header: t('applications.credentials.lastUsed'),
        accessor: (row) => (row.lastUsedAt ? new Date(row.lastUsedAt) : null),
        width: 150,
        cell: ({ row }) => (
          <Muted>
            {row.lastUsedAt
              ? new Date(row.lastUsedAt).toLocaleDateString()
              : t('applications.credentials.neverUsed')}
          </Muted>
        ),
      },
      {
        id: 'actions',
        header: '',
        headerAccessibilityLabel: t('applications.credentials.actions'),
        align: 'end',
        width: 150,
        cell: ({ row }) => {
          const live = row.status !== 'revoked';
          const identifier = row.tokenPrefix ?? row.publicKey;
          return (
            <DataTableRowActions
              name={row.name}
              actions={[
                {
                  icon: RiFileCopyLine,
                  label: row.tokenPrefix
                    ? t('applications.credentials.copyApiKeyId')
                    : t('applications.credentials.copyClientId'),
                  onPress: () =>
                    void copyText(
                      identifier,
                      row.tokenPrefix
                        ? t('applications.credentials.apiKeyIdCopied')
                        : t('applications.credentials.clientIdCopied'),
                    ),
                },
                // A revoked credential keeps its trail: the revocation is the part
                // worth reading.
                {
                  icon: RiHistoryLine,
                  label: t('applications.credentials.trail'),
                  onPress: () => setTrailFor(row),
                },
                ...(canRotate && live
                  ? [
                      {
                        icon: RiRefreshLine,
                        label: t('applications.credentials.rotate'),
                        onPress: () => setToRotate(row),
                      },
                    ]
                  : []),
                ...(canRevoke && live
                  ? [
                      {
                        icon: RiDeleteBinLine,
                        label: t('applications.credentials.revoke'),
                        onPress: () => setToRevoke(row),
                      },
                    ]
                  : []),
              ]}
            />
          );
        },
      },
    ],
    [t, canRotate, canRevoke],
  );

  if (!canRead) {
    return <EmptyState icon={RiKey2Line} title={t('applications.credentials.noPermission')} />;
  }

  if (isLoading) {
    return <Skeleton.Box width="100%" height={240} borderRadius={14} />;
  }

  if (isError) {
    return (
      <Admonition type="error">
        {t('applications.credentials.loadFailed')}{' '}
        <Button size="sm" appearance="plain" onPress={() => void refetch()}>
          {t('applications.retry')}
        </Button>
      </Admonition>
    );
  }

  return (
    <>
      {revealed ? <RevealedSecret value={revealed} onDismiss={() => setRevealed(null)} /> : null}

      <DataTable
        rows={credentials}
        columns={columns}
        getRowId={(row) => row._id}
        accessibilityLabel={t('applications.credentials.title')}
        title={t('applications.credentials.title')}
        summary={t('applications.credentials.count', { count: credentials.length })}
        toolbar={
          canCreate ? (
            <Button leadingIcon={RiAddLine} size="sm" onPress={() => setCreating(true)}>
              {t('applications.credentials.create')}
            </Button>
          ) : undefined
        }
        emptyState={
          <EmptyState
            icon={RiKey2Line}
            title={t('applications.credentials.empty')}
            description={t('applications.credentials.subtitle')}
          />
        }
        pageSize={10}
        minWidth={820}
      />

      <CreateCredentialDialog
        application={application}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={reveal}
      />

      <CredentialTrail appId={appId} credential={trailFor} onClose={() => setTrailFor(null)} />

      <Dialog
        open={toRotate !== null}
        onClose={() => setToRotate(null)}
        placement={{ base: 'bottom', md: 'center' }}
        title={t('applications.credentials.rotateTitle')}
        description={t('applications.credentials.rotateBody', { name: toRotate?.name ?? '' })}
        actions={[
          { label: t('common.cancel'), color: 'cancel', disabled: rotateCredential.isPending },
          {
            label: t('applications.credentials.rotateConfirm'),
            onPress: () => void handleRotate(),
            loading: rotateCredential.isPending,
            shouldCloseOnPress: false,
          },
        ]}
      />

      <Dialog
        open={toRevoke !== null}
        onClose={() => setToRevoke(null)}
        placement={{ base: 'bottom', md: 'center' }}
        title={t('applications.credentials.revokeTitle')}
        description={t('applications.credentials.revokeBody', { name: toRevoke?.name ?? '' })}
        actions={[
          { label: t('common.cancel'), color: 'cancel', disabled: revokeCredential.isPending },
          {
            label: t('applications.credentials.revokeConfirm'),
            color: 'destructive',
            onPress: () => void handleRevoke(),
            loading: revokeCredential.isPending,
            shouldCloseOnPress: false,
          },
        ]}
      />
    </>
  );
}
