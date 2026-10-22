import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { DataTable, DataTableRowActions, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiUserAddLine } from '@oxy.so/bloom/icons/RiUserAddLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { Code } from '@oxy.so/bloom/code';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo, useState } from 'react';

import {
  type ApplicationPermissionDeclaration,
  type ApplicationRoleGrant,
  useApplicationRoleGrants,
  useApplicationRolePermissions,
  useDeclareApplicationPermissions,
  useRevokeApplicationRoleGrant,
} from '@/hooks/use-application-roles';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { DeclarePermissionDialog } from './DeclarePermissionDialog';
import { GrantPermissionDialog } from './GrantPermissionDialog';

/**
 * Application roles: the permissions THIS application declares about its own
 * users (`payments.operate`, ...) and the people who hold them
 * (`docs/auth/application-roles.md`). The application's backend reads them
 * through `@oxy.so/core/server` (`requireAppPermission`).
 *
 * The API is declarative: saving the vocabulary replaces it, and a key left out
 * is retired with its grants revoked. Each add or remove here therefore sends
 * the whole next list, and removing confirms first.
 */
export function RolesPanel({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const appId = application._id;
  const canRead = access.can('roles:read');
  const canManage = access.can('roles:manage');
  const permissions = useApplicationRolePermissions(appId, canRead);
  const grants = useApplicationRoleGrants(appId, canRead);
  const declare = useDeclareApplicationPermissions();
  const revoke = useRevokeApplicationRoleGrant();

  const [declaring, setDeclaring] = useState(false);
  const [granting, setGranting] = useState(false);
  const [toRemove, setToRemove] = useState<ApplicationPermissionDeclaration | null>(null);

  const declared = useMemo<Array<ApplicationPermissionDeclaration>>(
    () => (permissions.data?.items ?? []).map(({ key, description }) => ({ key, description })),
    [permissions.data],
  );
  const grantItems = grants.data?.items ?? [];

  const save = async (next: Array<ApplicationPermissionDeclaration>) => {
    try {
      const result = await declare.mutateAsync({ appId, permissions: next });
      toast.success(
        result.revokedGrants > 0
          ? t('applications.roles.savedRevoked', { count: result.revokedGrants })
          : t('applications.roles.saved'),
      );
      return true;
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.roles.saveFailed')));
      return false;
    }
  };

  const revokeGrant = async (grantId: string) => {
    try {
      await revoke.mutateAsync({ appId, grantId });
      toast.success(t('applications.roles.revoked'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.roles.revokeFailed')));
    }
  };

  const permissionColumns = useMemo<
    ReadonlyArray<DataTableColumn<ApplicationPermissionDeclaration>>
  >(
    () => [
      {
        id: 'key',
        header: t('applications.roles.key'),
        accessor: (row) => row.key,
        minWidth: 200,
        cell: ({ row }) => <Code>{row.key}</Code>,
      },
      {
        id: 'description',
        header: t('applications.roles.description'),
        minWidth: 240,
        flex: 2,
        cell: ({ row }) => <Muted>{row.description}</Muted>,
      },
      {
        id: 'holders',
        header: t('applications.roles.holders'),
        align: 'end',
        width: 110,
        cell: ({ row }) => (
          <Text className="tabular-nums">
            {grantItems.filter((grant) => grant.permission === row.key).length}
          </Text>
        ),
      },
      ...(canManage
        ? [
            {
              id: 'actions',
              header: '',
              headerAccessibilityLabel: t('applications.credentials.actions'),
              align: 'end' as const,
              width: 80,
              cell: ({ row }: { row: ApplicationPermissionDeclaration }) => (
                <DataTableRowActions
                  name={row.key}
                  actions={[
                    {
                      icon: RiDeleteBinLine,
                      label: t('applications.roles.remove'),
                      onPress: () => setToRemove(row),
                    },
                  ]}
                />
              ),
            },
          ]
        : []),
    ],
    [t, canManage, grantItems],
  );

  const grantColumns: ReadonlyArray<DataTableColumn<ApplicationRoleGrant>> = [
    {
      id: 'person',
      header: t('applications.roles.person'),
      accessor: (row) => row.username ?? row.userId,
      minWidth: 180,
      cell: ({ row }) => <Text>{row.username ? `@${row.username}` : row.userId}</Text>,
    },
    {
      id: 'permission',
      header: t('applications.roles.permission'),
      accessor: (row) => row.permission,
      minWidth: 180,
      cell: ({ row }) => <Code>{row.permission}</Code>,
    },
    {
      id: 'reason',
      header: t('applications.roles.reason'),
      minWidth: 200,
      flex: 2,
      cell: ({ row }) => <Muted>{row.grantReason ?? ''}</Muted>,
    },
    {
      id: 'since',
      header: t('applications.roles.sinceColumn'),
      accessor: (row) => new Date(row.grantedAt),
      width: 130,
      cell: ({ row }) => <Muted>{new Date(row.grantedAt).toLocaleDateString()}</Muted>,
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: '',
            headerAccessibilityLabel: t('applications.credentials.actions'),
            align: 'end' as const,
            width: 80,
            cell: ({ row }: { row: ApplicationRoleGrant }) => (
              <DataTableRowActions
                name={row.username ?? row.userId}
                actions={[
                  {
                    icon: RiDeleteBinLine,
                    label: t('applications.roles.revoke'),
                    onPress: () => void revokeGrant(row.id),
                  },
                ]}
              />
            ),
          },
        ]
      : []),
  ];

  if (!canRead) {
    return <EmptyState icon={RiGroupLine} title={t('applications.roles.noPermission')} />;
  }

  if (permissions.isLoading || grants.isLoading) {
    return (
      <>
        <Skeleton.Box width="100%" height={200} borderRadius={14} />
        <Skeleton.Box width="100%" height={200} borderRadius={14} />
      </>
    );
  }

  if (permissions.isError || grants.isError) {
    return (
      <Admonition type="error">
        {t('applications.roles.loadFailed')}{' '}
        <Button
          size="sm"
          appearance="plain"
          onPress={() => {
            void permissions.refetch();
            void grants.refetch();
          }}
        >
          {t('applications.retry')}
        </Button>
      </Admonition>
    );
  }

  const removedGrants = toRemove
    ? grantItems.filter((grant) => grant.permission === toRemove.key).length
    : 0;

  return (
    <>
      <DataTable
        rows={declared}
        columns={permissionColumns}
        getRowId={(row) => row.key}
        accessibilityLabel={t('applications.roles.permissionsTitle')}
        title={t('applications.roles.permissionsTitle')}
        summary={t('applications.roles.permissionsBody')}
        toolbar={
          canManage ? (
            <Button leadingIcon={RiAddLine} size="sm" onPress={() => setDeclaring(true)}>
              {t('applications.roles.add')}
            </Button>
          ) : undefined
        }
        emptyState={<EmptyState icon={RiGroupLine} title={t('applications.roles.none')} />}
        pageSize={10}
        minWidth={640}
      />

      <DataTable
        rows={grantItems}
        columns={grantColumns}
        getRowId={(row) => row.id}
        accessibilityLabel={t('applications.roles.peopleTitle')}
        title={t('applications.roles.peopleTitle')}
        summary={t('applications.roles.peopleBody')}
        toolbar={
          canManage && declared.length > 0 ? (
            <Button leadingIcon={RiUserAddLine} size="sm" onPress={() => setGranting(true)}>
              {t('applications.roles.grantTitle')}
            </Button>
          ) : undefined
        }
        emptyState={<EmptyState icon={RiUserAddLine} title={t('applications.roles.nobody')} />}
        pageSize={10}
        minWidth={700}
      />

      <DeclarePermissionDialog
        open={declaring}
        existingKeys={declared.map((row) => row.key)}
        saving={declare.isPending}
        onClose={() => setDeclaring(false)}
        onDeclare={(permission) => save([...declared, permission])}
      />

      <GrantPermissionDialog
        appId={appId}
        keys={declared.map((row) => row.key)}
        open={granting}
        onClose={() => setGranting(false)}
      />

      <Dialog
        open={toRemove !== null}
        onClose={() => setToRemove(null)}
        placement={{ base: 'bottom', md: 'center' }}
        title={t('applications.roles.retiresTitle', { keys: toRemove?.key ?? '' })}
        description={`${t('applications.roles.retiresBody')} ${t('applications.roles.retiresCount', { count: removedGrants })}`}
        actions={[
          { label: t('common.cancel'), color: 'cancel', disabled: declare.isPending },
          {
            label: t('applications.roles.remove'),
            color: 'destructive',
            loading: declare.isPending,
            shouldCloseOnPress: false,
            onPress: () => {
              if (!toRemove) return;
              void save(declared.filter((row) => row.key !== toRemove.key)).then((ok) => {
                if (ok) setToRemove(null);
              });
            },
          },
        ]}
      />
    </>
  );
}
