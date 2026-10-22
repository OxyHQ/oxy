import { Avatar } from '@oxy.so/bloom/avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import {
  DataTable,
  type DataTableColumn,
  DataTableFilter,
  DataTableRowActions,
  DataTableSelect,
} from '@oxy.so/bloom/data-table';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiDeleteBin6Line } from '@oxy.so/bloom/icons/RiDeleteBin6Line';
import { RiExchangeLine } from '@oxy.so/bloom/icons/RiExchangeLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { RiVipCrownLine } from '@oxy.so/bloom/icons/RiVipCrownLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import type { AccountInvitation } from '@oxy.so/core';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { useAuth } from '@oxy.so/services/ui/client';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, View } from 'react-native';
import { statusBadge } from '@/components/billing/labels';
import { AccountAvatarField } from '@/components/settings/AccountAvatarField';
import {
  accountInitials,
  resolveStoredImageUrl,
  useAccountLabels,
} from '@/components/settings/account-labels';
import {
  type AccountMember,
  type AssignableAccountRole,
  useAccount,
  useAccountMembers,
  useInviteAccountMember,
  useRemoveAccountMember,
  useTransferAccountOwnership,
  useUpdateAccountMember,
} from '@/hooks/use-account';
import { useConsoleSettings } from '@/components/settings/ConsoleSettings';
import { getErrorMessage } from '@/lib/api-error';
import config from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import { stripSensitiveImageUrlQueryParams } from '@/lib/image-upload';

const ASSIGNABLE_ROLES: Array<AssignableAccountRole> = [
  'admin',
  'editor',
  'developer',
  'billing',
  'viewer',
];

/** Short, readable handle for a member identified only by user id. */
function shortUserId(userId: string): string {
  return userId.length > 10 ? `${userId.slice(0, 6)}…${userId.slice(-4)}` : userId;
}

export function AccountSection() {
  const { t } = useTranslation();
  const labels = useAccountLabels();
  const router = useRouter();
  const { close } = useConsoleSettings();
  const { user, oxyServices } = useAuth();
  const {
    accounts,
    currentAccount,
    setCurrentAccount,
    updateAccount,
    archiveAccount,
    canEditAccount,
    canManageMembers,
    canTransferOwnership,
    canArchiveAccount,
  } = useAccount();

  const accountId = currentAccount?.accountId;
  const isPersonal = currentAccount?.kind === 'personal';
  const accountUser = currentAccount?.account;

  // The display label for the account: its canonical `name.displayName`, falling
  // back to the handle. Used in the header and the archive confirmation.
  const label = accountUser?.name?.displayName ?? getNormalizedUserHandle(accountUser) ?? '';

  // Members are fetched only for non-personal accounts with permission to read.
  const canManage = currentAccount ? canManageMembers(currentAccount) : false;
  const canTransfer = currentAccount ? canTransferOwnership(currentAccount) : false;
  const membersQuery = useAccountMembers(accountId, !!currentAccount && !isPersonal);
  const members = membersQuery.data ?? [];
  const activeMembers = members.filter((m) => m.status === 'active');
  const invitationsQuery = useQuery({
    queryKey: ['account-invitations', accountId],
    queryFn: () => oxyServices.accounts.invitations.list(accountId ?? ''),
    enabled: !!accountId && !!currentAccount && !isPersonal,
  });
  const pendingInvites = invitationsQuery.data ?? [];
  // DIRECT owners only. The list also carries members whose row lives on an
  // ancestor account, and the last-owner rule this count feeds is about the rows
  // on THIS account — which is what the server's own guard counts. Including an
  // inherited owner would make a child with no owner of its own look like it has
  // exactly one, and silently disable removing anybody.
  const ownerCount = activeMembers.filter(
    (m) => m.role === 'owner' && (m.source ?? 'direct') === 'direct',
  ).length;

  const inviteMemberMutation = useInviteAccountMember();
  const updateMemberMutation = useUpdateAccountMember();
  const removeMemberMutation = useRemoveAccountMember();
  const transferOwnershipMutation = useTransferAccountOwnership();

  // General form. The org/project display name is carried in `name.displayName`
  // (set server-side from the structured name); editing it writes back through
  // `name.first`.
  const [name, setName] = useState(() => currentAccount?.account.name?.displayName ?? '');
  const [bio, setBio] = useState(() => currentAccount?.account.bio ?? '');
  const [avatar, setAvatar] = useState(() => currentAccount?.account.avatar ?? '');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!currentAccount) {
      return;
    }
    setName(currentAccount.account.name?.displayName ?? '');
    setBio(currentAccount.account.bio ?? '');
    setAvatar(currentAccount.account.avatar ?? '');
  }, [
    currentAccount?.accountId,
    currentAccount?.account.bio,
    currentAccount?.account.avatar,
    currentAccount?.account.name?.displayName,
  ]);

  // Invite dialog state
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteIdentifier, setInviteIdentifier] = useState('');
  const [inviteRole, setInviteRole] = useState<AssignableAccountRole>('editor');
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Member action state
  const [memberToPromote, setMemberToPromote] = useState<AccountMember | null>(null);

  // Archive dialog state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const roleOptions = useMemo(
    () => ASSIGNABLE_ROLES.map((role) => ({ value: role, label: labels.role(role) })),
    [labels],
  );

  if (!currentAccount || !accountId) {
    return <Muted>{t('common.loading')}</Muted>;
  }

  const canEdit = canEditAccount(currentAccount);
  const canDelete = canArchiveAccount(currentAccount) && !isPersonal;

  // Personal accounts show the signed-in user's avatar (read-only — it is
  // managed in the user's Oxy account).
  const userLabel = user?.name?.displayName ?? getNormalizedUserHandle(user) ?? '';

  const handleSave = async () => {
    const trimmed = name.trim();
    // Personal accounts cannot be renamed — never send a name change for them.
    if (!isPersonal && !trimmed) {
      toast.error(t('settingsPage.general.nameRequired'));
      return;
    }

    setIsSaving(true);
    try {
      await updateAccount(accountId, {
        // Omit `name` for personal accounts (rename is blocked server-side).
        // For org/project accounts the display name is stored in `name.first`.
        ...(isPersonal ? {} : { name: { first: trimmed } }),
        bio: bio.trim() || null,
      });
      toast.success(t('settingsPage.general.updated'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('settingsPage.general.updateFailed')));
    } finally {
      setIsSaving(false);
    }
  };

  // The avatar uploader resolves a public URL, then persists it immediately so
  // the change lands without requiring the "Save changes" button. Only rendered
  // for non-personal accounts — personal accounts inherit the user's account
  // avatar and expose no uploader.
  const handleAvatarChange = async (url: string) => {
    const safeUrl = stripSensitiveImageUrlQueryParams(url);
    setAvatar(safeUrl);
    try {
      await updateAccount(accountId, { avatar: safeUrl || null });
      toast.success(
        t(safeUrl ? 'settingsPage.general.avatarUpdated' : 'settingsPage.general.avatarRemoved'),
      );
    } catch (error) {
      // Revert the local preview to the persisted value on failure.
      setAvatar(currentAccount.account.avatar ?? '');
      toast.error(getErrorMessage(error, t('settingsPage.general.avatarFailed')));
    }
  };

  const closeInviteDialog = () => {
    setShowInviteDialog(false);
    setInviteIdentifier('');
    setInviteRole('editor');
    setInviteError(null);
  };

  const handleInvite = async () => {
    const usernameOrEmail = inviteIdentifier.trim();
    if (!usernameOrEmail) {
      setInviteError(t('settingsPage.invite.required'));
      return;
    }
    setInviteError(null);

    try {
      await inviteMemberMutation.mutateAsync({ accountId, usernameOrEmail, role: inviteRole });
      toast.success(t('settingsPage.invite.sent'));
      closeInviteDialog();
    } catch (error) {
      await invitationsQuery.refetch();
      toast.error(getErrorMessage(error, t('settingsPage.invite.failed')));
    }
  };

  const handleRemoveMember = async (member: AccountMember) => {
    try {
      await removeMemberMutation.mutateAsync({ accountId, memberId: member._id });
      toast.success(t('settingsPage.members.removed'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('settingsPage.members.removeFailed')));
    }
  };

  const handleRoleChange = async (member: AccountMember, role: AssignableAccountRole) => {
    if (role === member.role) {
      return;
    }
    try {
      await updateMemberMutation.mutateAsync({ accountId, memberId: member._id, role });
      toast.success(t('settingsPage.members.roleUpdated'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('settingsPage.members.roleFailed')));
    }
  };

  const handleTransfer = async () => {
    if (!memberToPromote) {
      return;
    }
    try {
      await transferOwnershipMutation.mutateAsync({
        accountId,
        userId: memberToPromote.memberUserId,
      });
      setMemberToPromote(null);
      toast.success(t('settingsPage.members.transferred'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('settingsPage.members.transferFailed')));
    }
  };

  const handleCancelInvite = async (invite: AccountInvitation) => {
    try {
      await oxyServices.accounts.invitations.cancel(accountId, invite.id);
      await invitationsQuery.refetch();
      toast.success(t('settingsPage.invitations.cancelled'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('settingsPage.invitations.cancelFailed')));
    }
  };

  const handleResendInvite = async (invite: AccountInvitation) => {
    try {
      await oxyServices.accounts.invitations.resend(accountId, invite.id);
      await invitationsQuery.refetch();
      toast.success(t('settingsPage.invitations.resent'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('settingsPage.invitations.resendFailed')));
    }
  };

  const handleDelete = async () => {
    if (deleteConfirmation !== label) {
      toast.error(t('settingsPage.archive.confirmMismatch'));
      return;
    }

    setIsDeleting(true);
    try {
      await archiveAccount(accountId);
      if (user?.id === accountId) {
        const personal = accounts.find((node) => node.relationship === 'self');
        if (personal) {
          await setCurrentAccount(personal);
        }
      }
      toast.success(t('settingsPage.archive.archived'));
      setShowDeleteDialog(false);
      setDeleteConfirmation('');
      close();
      router.navigate('/dashboard');
    } catch (error) {
      // The API returns 409 when the account still owns applications.
      toast.error(getErrorMessage(error, t('settingsPage.archive.failed')));
    } finally {
      setIsDeleting(false);
    }
  };

  const memberColumns: ReadonlyArray<DataTableColumn<AccountMember>> = [
    {
      id: 'member',
      header: t('settingsPage.members.title'),
      minWidth: 200,
      cell: ({ row }) => (
        <View className="min-w-0 flex-row items-center gap-3">
          <Avatar
            size={32}
            initials={row.memberUserId[0]?.toUpperCase() ?? '?'}
            alt={row.memberUserId}
          />
          <Text className="font-mono text-sm" numberOfLines={1}>
            {shortUserId(row.memberUserId)}
          </Text>
        </View>
      ),
    },
    {
      id: 'role',
      header: t('settingsPage.members.role'),
      minWidth: 200,
      cell: ({ row, size }) => {
        const isOwner = row.role === 'owner';
        // An INHERITED entry's row lives on an ancestor account, and every
        // member mutation is scoped to rows on the account in the path — so
        // offering to edit, remove or promote one would be offering a
        // request the server answers 404. It is changed where it lives, on
        // that ancestor's own members screen.
        const isEditableHere = (row.source ?? 'direct') === 'direct';
        return (
          <View className="flex-row flex-wrap items-center gap-2">
            {!isEditableHere ? (
              <Badge content={t('settingsPage.members.inherited')} {...statusBadge('outline')} />
            ) : null}
            {isOwner ? (
              <Badge
                content={labels.role('owner')}
                icon={RiVipCrownLine}
                {...statusBadge('default')}
              />
            ) : canManage && isEditableHere ? (
              <DataTableSelect
                label={t('settingsPage.members.role')}
                options={roleOptions}
                value={row.role}
                width={144}
                size={size}
                onValueChange={(role) => void handleRoleChange(row, role as AssignableAccountRole)}
              />
            ) : (
              <Badge content={labels.role(row.role)} {...statusBadge('outline')} />
            )}
          </View>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      headerAccessibilityLabel: t('settingsPage.members.title'),
      align: 'end',
      width: 96,
      cell: ({ row }) => {
        const isOwner = row.role === 'owner';
        const isLastOwner = isOwner && ownerCount <= 1;
        const isEditableHere = (row.source ?? 'direct') === 'direct';
        const canRemoveThisMember = canManage && isEditableHere && !isOwner && !isLastOwner;
        const canTransferToThis = canTransfer && isEditableHere && !isOwner;
        return (
          <DataTableRowActions
            name={shortUserId(row.memberUserId)}
            actions={[
              ...(canTransferToThis
                ? [
                    {
                      icon: RiExchangeLine,
                      label: t('settingsPage.members.transfer'),
                      onPress: () => setMemberToPromote(row),
                    },
                  ]
                : []),
              ...(canRemoveThisMember
                ? [
                    {
                      icon: RiCloseLine,
                      label: t('settingsPage.members.remove'),
                      onPress: () => void handleRemoveMember(row),
                    },
                  ]
                : []),
            ]}
          />
        );
      },
    },
  ];

  const invitationColumns: ReadonlyArray<DataTableColumn<AccountInvitation>> = [
    {
      id: 'email',
      header: t('settingsPage.invite.email'),
      minWidth: 200,
      cell: ({ row }) => (
        <Text className="font-mono text-sm" numberOfLines={1}>
          {row.email}
        </Text>
      ),
    },
    {
      id: 'details',
      header: t('settingsPage.invitations.title'),
      minWidth: 200,
      cell: ({ row }) => (
        <Muted>
          {row.status} • {labels.role(row.role)}
          {row.createdAt ? ` • ${new Date(row.createdAt).toLocaleDateString()}` : ''}
        </Muted>
      ),
    },
    {
      id: 'actions',
      header: '',
      headerAccessibilityLabel: t('settingsPage.invitations.title'),
      align: 'end',
      width: 96,
      cell: ({ row }) =>
        canManage ? (
          <DataTableRowActions
            name={row.email}
            actions={[
              {
                icon: RiRefreshLine,
                label: t('settingsPage.invitations.resend'),
                onPress: () => void handleResendInvite(row),
              },
              {
                icon: RiCloseLine,
                label: t('common.cancel'),
                onPress: () => void handleCancelInvite(row),
              },
            ]}
          />
        ) : null,
    },
  ];

  return (
    <View className="gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('settingsPage.general.title')}</CardTitle>
        </CardHeader>
        <CardBody>
          <View className="max-w-md gap-4">
            <Field label={t('settingsPage.general.avatar')}>
              {isPersonal ? (
                <View className="flex-row items-center gap-3">
                  <Avatar
                    size={56}
                    uri={resolveStoredImageUrl(oxyServices, user?.avatar)}
                    initials={accountInitials(userLabel)}
                    alt={label}
                  />
                  <Muted className="min-w-0 flex-1 text-xs">
                    {t('settingsPage.general.personalAvatar')}{' '}
                    <Text
                      accessibilityRole="link"
                      className="text-xs font-medium underline"
                      onPress={() => void Linking.openURL(config.accountsUrl)}
                    >
                      {t('settingsPage.general.managedInOxy')}
                    </Text>
                  </Muted>
                </View>
              ) : (
                <AccountAvatarField
                  value={avatar}
                  initials={accountInitials(label)}
                  label={t('settingsPage.general.accountAvatar')}
                  disabled={!canEdit}
                  onChange={(url) => void handleAvatarChange(url)}
                  onError={(message) => toast.error(message)}
                />
              )}
            </Field>

            <Field
              label={t('settingsPage.general.name')}
              description={isPersonal ? t('settingsPage.general.personalNameLocked') : undefined}
            >
              <TextFieldInput
                label={t('settingsPage.general.name')}
                value={name}
                onChangeText={setName}
                disabled={!canEdit || isPersonal}
                maxLength={50}
              />
            </Field>

            {!isPersonal && accountUser?.username ? (
              <Field label={t('settingsPage.general.handle')}>
                <Muted className="font-mono">@{accountUser.username}</Muted>
              </Field>
            ) : null}

            <Field label={t('settingsPage.general.description')}>
              <Textarea
                label={t('settingsPage.general.description')}
                value={bio}
                onChangeText={setBio}
                disabled={!canEdit}
                placeholder={t('settingsPage.general.descriptionPlaceholder')}
                rows={3}
              />
            </Field>

            {canEdit && !isPersonal ? (
              <View className="items-start">
                <Button onPress={() => void handleSave()} disabled={isSaving}>
                  {isSaving ? t('settingsPage.general.saving') : t('settingsPage.general.save')}
                </Button>
              </View>
            ) : null}
          </View>
        </CardBody>
      </Card>

      {!isPersonal &&
        (membersQuery.isLoading ? (
          <Skeleton.Box width="100%" height={176} />
        ) : (
          <DataTable
            rows={activeMembers}
            columns={memberColumns}
            getRowId={(row) => row._id}
            accessibilityLabel={t('settingsPage.members.title')}
            title={t('settingsPage.members.title')}
            toolbar={
              canManage ? (
                <Button size="sm" leadingIcon={RiAddLine} onPress={() => setShowInviteDialog(true)}>
                  {t('settingsPage.members.invite')}
                </Button>
              ) : undefined
            }
            minWidth={520}
            emptyState={<Muted>{t('settingsPage.members.none')}</Muted>}
          />
        ))}

      {!isPersonal && pendingInvites.length > 0 && (
        <DataTable
          rows={pendingInvites}
          columns={invitationColumns}
          getRowId={(row) => row.id}
          accessibilityLabel={t('settingsPage.invitations.title')}
          title={t('settingsPage.invitations.title')}
          minWidth={520}
        />
      )}

      {/* Billing — account billing isn't a backend concept here; the dedicated Billing page covers it. */}
      <GroupedSection title={t('settingsPage.billing.title')}>
        <GroupedSectionItem
          title={t('settingsPage.billing.heading')}
          description={t('settingsPage.billing.body')}
          value={t('settingsPage.billing.manage')}
          onPress={() => {
            close();
            router.navigate('/billing');
          }}
        />
      </GroupedSection>

      {/* Danger zone */}
      {canDelete && (
        <GroupedSection title={t('settingsPage.archive.zone')}>
          <GroupedSectionItem
            destructive
            icon={<RiDeleteBin6Line size="md" />}
            title={t('settingsPage.archive.action')}
            description={`${t('settingsPage.archive.heading')} ${t('settingsPage.archive.body')}`}
            onPress={() => setShowDeleteDialog(true)}
          />
        </GroupedSection>
      )}

      {/* Invite dialog */}
      <Dialog
        open={showInviteDialog}
        onClose={closeInviteDialog}
        title={t('settingsPage.invite.title')}
        description={t('settingsPage.invite.description')}
        actions={[
          { label: t('common.cancel'), color: 'cancel' },
          {
            label: inviteMemberMutation.isPending
              ? t('settingsPage.invite.sending')
              : t('settingsPage.invite.send'),
            onPress: () => void handleInvite(),
            disabled: inviteMemberMutation.isPending || !inviteIdentifier.trim(),
            shouldCloseOnPress: false,
          },
        ]}
      >
        <View className="gap-4 py-2">
          <Field label={t('settingsPage.invite.email')} error={inviteError}>
            <TextFieldInput
              label={t('settingsPage.invite.email')}
              value={inviteIdentifier}
              onChangeText={(text) => {
                setInviteIdentifier(text);
                if (inviteError) {
                  setInviteError(null);
                }
              }}
              onSubmitEditing={() => void handleInvite()}
              placeholder={t('settingsPage.invite.placeholder')}
              invalid={inviteError !== null}
              autoCapitalize="none"
            />
          </Field>
          <Field
            label={t('settingsPage.members.role')}
            description={t(`settingsPage.roleDescriptions.${inviteRole}`)}
          >
            <DataTableFilter
              label={t('settingsPage.members.role')}
              value={inviteRole}
              options={roleOptions}
              onValueChange={(role) => setInviteRole(role as AssignableAccountRole)}
            />
          </Field>
        </View>
      </Dialog>

      {/* Transfer ownership confirmation */}
      <Dialog
        open={memberToPromote !== null}
        onClose={() => setMemberToPromote(null)}
        title={t('settingsPage.members.transfer')}
        description={t('settingsPage.members.transferBody')}
        actions={[
          { label: t('common.cancel'), color: 'cancel' },
          {
            label: transferOwnershipMutation.isPending
              ? t('settingsPage.members.transferring')
              : t('settingsPage.members.transfer'),
            onPress: () => void handleTransfer(),
            loading: transferOwnershipMutation.isPending,
            disabled: transferOwnershipMutation.isPending,
            shouldCloseOnPress: false,
          },
        ]}
      />

      {/* Archive confirmation */}
      <Dialog
        open={showDeleteDialog}
        onClose={() => {
          setShowDeleteDialog(false);
          setDeleteConfirmation('');
        }}
        title={t('settingsPage.archive.action')}
        description={t('settingsPage.archive.confirmBody', { name: label })}
        actions={[
          { label: t('common.cancel'), color: 'cancel' },
          {
            label: isDeleting
              ? t('settingsPage.archive.archiving')
              : t('settingsPage.archive.confirmAction'),
            color: 'destructive',
            onPress: () => void handleDelete(),
            loading: isDeleting,
            disabled: isDeleting || deleteConfirmation !== label,
            shouldCloseOnPress: false,
          },
        ]}
      >
        <Field label={t('settingsPage.archive.typeToConfirm', { name: label })}>
          <TextFieldInput
            label={t('settingsPage.archive.confirmLabel')}
            value={deleteConfirmation}
            onChangeText={setDeleteConfirmation}
            placeholder={label}
          />
        </Field>
      </Dialog>
    </View>
  );
}
