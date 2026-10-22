import { Avatar } from '@oxy.so/bloom/avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { DataTableRowActions } from '@oxy.so/bloom/data-table';
import { Dialog } from '@oxy.so/bloom/dialog';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiExchangeLine } from '@oxy.so/bloom/icons/RiExchangeLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { RiVipCrownLine } from '@oxy.so/bloom/icons/RiVipCrownLine';
import {
  SettingsGeneralPage,
  type SettingsPageSection,
  SettingsTextField,
  SettingsValueField,
} from '@oxy.so/bloom/settings-modal';
import { toast } from '@oxy.so/bloom/toast';
import type { AccountInvitation } from '@oxy.so/core';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { useAuth } from '@oxy.so/services/ui/client';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, View } from 'react-native';
import { ApiState } from '@/components/loading/ApiState';
import { FormSkeleton, ListSkeleton } from '@/components/loading/ContentSkeleton';
import { AccountAvatarField } from '@/components/settings/AccountAvatarField';
import { accountInitials, useAccountLabels } from '@/components/settings/account-labels';
import { useConsoleSettings } from '@/components/settings/ConsoleSettings';
import { ArchiveAccountDialog } from '@/components/settings/ArchiveAccountDialog';
import { ASSIGNABLE_ROLES, InviteMemberDialog } from '@/components/settings/InviteMemberDialog';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import {
  type AccountMember,
  type AssignableAccountRole,
  useAccount,
  useAccountMembers,
  useRemoveAccountMember,
  useTransferAccountOwnership,
  useUpdateAccountMember,
} from '@/hooks/use-account';
import { getErrorMessage } from '@/lib/api-error';
import config from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import { resolveStoredImageUrl, stripSensitiveImageUrlQueryParams } from '@/lib/image-upload';

/** Short, readable handle for a member identified only by user id. */
function shortUserId(userId: string): string {
  return userId.length > 10 ? `${userId.slice(0, 6)}…${userId.slice(-4)}` : userId;
}

type PendingMemberAction = { kind: 'remove' | 'transfer'; member: AccountMember };

/**
 * The workspace's settings: details, members, pending invitations, billing and archive.
 * Rows are data for Bloom's SettingsGeneralPage; permission gating comes from `useAccount`.
 */
export function AccountPage() {
  const { t } = useTranslation();
  const labels = useAccountLabels();
  const router = useRouter();
  const { close } = useConsoleSettings();
  const { oxyServices, user } = useAuth();
  const {
    currentAccount,
    updateAccount,
    canEditAccount,
    canManageMembers,
    canTransferOwnership,
    canArchiveAccount,
  } = useAccount();

  const accountId = currentAccount?.accountId;
  const isPersonal = currentAccount?.kind === 'personal';
  const membersQuery = useAccountMembers(accountId, !!currentAccount && !isPersonal);
  const invitationsQuery = useQuery({
    queryKey: ['account-invitations', accountId],
    queryFn: () => oxyServices.accounts.invitations.list(accountId ?? ''),
    enabled: !!accountId && !isPersonal,
  });
  const updateMember = useUpdateAccountMember();
  const removeMember = useRemoveAccountMember();
  const transferOwnership = useTransferAccountOwnership();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pending, setPending] = useState<PendingMemberAction | null>(null);

  if (!currentAccount || !accountId) {
    return <FormSkeleton />;
  }

  const account = currentAccount.account;
  const label = account.name?.displayName ?? getNormalizedUserHandle(account) ?? '';
  const canEdit = canEditAccount(currentAccount);
  const canManage = canManageMembers(currentAccount);
  const canTransfer = canTransferOwnership(currentAccount);
  const canArchive = canArchiveAccount(currentAccount) && !isPersonal;
  const activeMembers = (membersQuery.data ?? []).filter((member) => member.status === 'active');
  const pendingInvites = invitationsQuery.data ?? [];
  // DIRECT owners only: the last-owner rule is about the rows on THIS account, which is what
  // the server's guard counts. An inherited owner must not make a child look like it has one.
  const ownerCount = activeMembers.filter(
    (member) => member.role === 'owner' && (member.source ?? 'direct') === 'direct',
  ).length;

  const save = async (data: Parameters<typeof updateAccount>[1], failure: string) => {
    try {
      await updateAccount(accountId, data);
    } catch (error) {
      toast.error(getErrorMessage(error, failure));
    }
  };

  const changeAvatar = async (url: string) => {
    const safeUrl = stripSensitiveImageUrlQueryParams(url);
    try {
      await updateAccount(accountId, { avatar: safeUrl || null });
      toast.success(
        t(safeUrl ? 'settingsPage.general.avatarUpdated' : 'settingsPage.general.avatarRemoved'),
      );
    } catch (error) {
      toast.error(getErrorMessage(error, t('settingsPage.general.avatarFailed')));
    }
  };

  const changeRole = async (member: AccountMember, role: AssignableAccountRole) => {
    if (role === member.role) return;
    try {
      await updateMember.mutateAsync({ accountId, memberId: member._id, role });
      toast.success(t('settingsPage.members.roleUpdated'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('settingsPage.members.roleFailed')));
    }
  };

  const confirmPending = async () => {
    if (!pending) return;
    const { kind, member } = pending;
    try {
      if (kind === 'remove') {
        await removeMember.mutateAsync({ accountId, memberId: member._id });
        toast.success(t('settingsPage.members.removed'));
      } else {
        await transferOwnership.mutateAsync({ accountId, userId: member.memberUserId });
        toast.success(t('settingsPage.members.transferred'));
      }
      setPending(null);
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          t(
            kind === 'remove'
              ? 'settingsPage.members.removeFailed'
              : 'settingsPage.members.transferFailed',
          ),
        ),
      );
    }
  };

  const invitationAction = async (invite: AccountInvitation, action: 'resend' | 'cancel') => {
    try {
      await oxyServices.accounts.invitations[action](accountId, invite.id);
      await invitationsQuery.refetch();
      toast.success(
        t(
          action === 'resend'
            ? 'settingsPage.invitations.resent'
            : 'settingsPage.invitations.cancelled',
        ),
      );
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          t(
            action === 'resend'
              ? 'settingsPage.invitations.resendFailed'
              : 'settingsPage.invitations.cancelFailed',
          ),
        ),
      );
    }
  };

  const details: SettingsPageSection = {
    key: 'details',
    label: t('settingsPage.general.title'),
    rows: [
      {
        key: 'avatar',
        label: t('settingsPage.general.avatar'),
        description: isPersonal ? t('settingsPage.general.personalAvatar') : undefined,
        control: isPersonal ? (
          <View className="flex-row items-center gap-2">
            <Avatar
              size={40}
              uri={resolveStoredImageUrl(oxyServices, user?.avatar)}
              initials={accountInitials(label)}
              alt={label}
            />
            <Button
              size="sm"
              appearance="subtle"
              tone="neutral"
              onPress={() => void Linking.openURL(config.accountsUrl)}
            >
              {t('settingsPage.general.managedInOxy')}
            </Button>
          </View>
        ) : (
          <AccountAvatarField
            value={account.avatar ?? ''}
            initials={accountInitials(label)}
            label={t('settingsPage.general.accountAvatar')}
            disabled={!canEdit}
            onChange={(url) => void changeAvatar(url)}
            onError={(message) => toast.error(message)}
          />
        ),
      },
      {
        key: 'name',
        label: t('settingsPage.general.name'),
        description: isPersonal ? t('settingsPage.general.personalNameLocked') : undefined,
        control: (
          <SettingsTextField
            label={t('settingsPage.general.name')}
            value={account.name?.displayName ?? ''}
            disabled={!canEdit || isPersonal}
            onCommit={(value) => {
              const name = value.trim();
              if (!name) {
                toast.error(t('settingsPage.general.nameRequired'));
                return;
              }
              void save({ name: { first: name } }, t('settingsPage.general.updateFailed'));
            }}
          />
        ),
      },
      ...(!isPersonal && account.username
        ? [
            {
              key: 'handle',
              label: t('settingsPage.general.handle'),
              control: <SettingsValueField muted>@{account.username}</SettingsValueField>,
            },
          ]
        : []),
      {
        key: 'description',
        label: t('settingsPage.general.description'),
        control: (
          <SettingsTextField
            label={t('settingsPage.general.description')}
            value={account.bio ?? ''}
            placeholder={t('settingsPage.general.descriptionPlaceholder')}
            disabled={!canEdit}
            onCommit={(value) =>
              void save({ bio: value.trim() || null }, t('settingsPage.general.updateFailed'))
            }
          />
        ),
      },
    ],
  };

  const members: SettingsPageSection = {
    key: 'members',
    label: t('settingsPage.members.title'),
    action: canManage ? (
      <Button size="sm" leadingIcon={RiAddLine} onPress={() => setInviteOpen(true)}>
        {t('settingsPage.members.invite')}
      </Button>
    ) : undefined,
    emptyState: { title: t('settingsPage.members.none') },
    rows: activeMembers.map((member) => {
      const isOwner = member.role === 'owner';
      const isEditableHere = (member.source ?? 'direct') === 'direct';
      const isLastOwner = isOwner && ownerCount <= 1;
      const name = shortUserId(member.memberUserId);
      const actions = [
        ...(canTransfer && isEditableHere && !isOwner
          ? [
              {
                icon: RiExchangeLine,
                label: t('settingsPage.members.transfer'),
                onPress: () => setPending({ kind: 'transfer', member }),
              },
            ]
          : []),
        ...(canManage && isEditableHere && !isOwner && !isLastOwner
          ? [
              {
                icon: RiCloseLine,
                label: t('settingsPage.members.remove'),
                onPress: () => setPending({ kind: 'remove', member }),
              },
            ]
          : []),
      ];
      return {
        key: member._id,
        label: name,
        description: isEditableHere ? undefined : t('settingsPage.members.inherited'),
        control: (
          <View className="flex-row items-center gap-2">
            {isOwner ? (
              <Badge
                content={labels.role('owner')}
                icon={RiVipCrownLine}
                tone="neutral"
                appearance="solid"
                size="label-small"
              />
            ) : canManage && isEditableHere ? (
              <SettingsSelect
                label={t('settingsPage.members.role')}
                value={member.role as AssignableAccountRole}
                onChange={(role) => void changeRole(member, role)}
                items={ASSIGNABLE_ROLES.map((role) => ({ value: role, label: labels.role(role) }))}
              />
            ) : (
              <Badge
                content={labels.role(member.role)}
                tone="neutral"
                appearance="outline"
                size="label-small"
              />
            )}
            {actions.length > 0 ? <DataTableRowActions name={name} actions={actions} /> : null}
          </View>
        ),
      };
    }),
  };

  const invitations: SettingsPageSection = {
    key: 'invitations',
    label: t('settingsPage.invitations.title'),
    rows: pendingInvites.map((invite) => ({
      key: invite.id,
      label: invite.email,
      description: `${labels.role(invite.role)}${
        invite.createdAt ? ` · ${new Date(invite.createdAt).toLocaleDateString()}` : ''
      }`,
      control: canManage ? (
        <DataTableRowActions
          name={invite.email}
          actions={[
            {
              icon: RiRefreshLine,
              label: t('settingsPage.invitations.resend'),
              onPress: () => void invitationAction(invite, 'resend'),
            },
            {
              icon: RiCloseLine,
              label: t('common.cancel'),
              onPress: () => void invitationAction(invite, 'cancel'),
            },
          ]}
        />
      ) : undefined,
    })),
  };

  const billing: SettingsPageSection = {
    key: 'billing',
    label: t('settingsPage.billing.title'),
    rows: [
      {
        key: 'billing',
        label: t('settingsPage.billing.heading'),
        description: t('settingsPage.billing.body'),
        control: (
          <Button
            size="sm"
            appearance="subtle"
            tone="neutral"
            onPress={() => {
              close();
              router.navigate('/billing');
            }}
          >
            {t('settingsPage.billing.manage')}
          </Button>
        ),
      },
    ],
  };

  const danger: SettingsPageSection = {
    key: 'danger',
    label: t('settingsPage.archive.zone'),
    rows: [
      {
        key: 'archive',
        label: t('settingsPage.archive.heading'),
        description: t('settingsPage.archive.body'),
        control: (
          <Button size="sm" appearance="subtle" tone="danger" onPress={() => setArchiveOpen(true)}>
            {t('settingsPage.archive.action')}
          </Button>
        ),
      },
    ],
  };

  return (
    <View className="gap-6">
      <SettingsGeneralPage sections={[details]} />

      {isPersonal ? null : membersQuery.isLoading ? (
        <ListSkeleton count={3} />
      ) : membersQuery.isError ? (
        <ApiState error={membersQuery.error} onRetry={() => void membersQuery.refetch()} />
      ) : (
        <SettingsGeneralPage
          sections={[members, ...(pendingInvites.length > 0 ? [invitations] : [])]}
        />
      )}

      <SettingsGeneralPage sections={[billing, ...(canArchive ? [danger] : [])]} />

      <InviteMemberDialog
        accountId={accountId}
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={() => void invitationsQuery.refetch()}
      />
      <ArchiveAccountDialog
        accountId={accountId}
        label={label}
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onArchived={() => {
          close();
          router.navigate('/dashboard');
        }}
      />
      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={t(
          pending?.kind === 'remove'
            ? 'settingsPage.members.remove'
            : 'settingsPage.members.transfer',
        )}
        description={t(
          pending?.kind === 'remove'
            ? 'settingsPage.members.removeBody'
            : 'settingsPage.members.transferBody',
        )}
        actions={[
          { label: t('common.cancel'), color: 'cancel' },
          {
            label: t(
              pending?.kind === 'remove'
                ? 'settingsPage.members.remove'
                : 'settingsPage.members.transfer',
            ),
            color: pending?.kind === 'remove' ? 'destructive' : undefined,
            onPress: () => void confirmPending(),
            loading: removeMember.isPending || transferOwnership.isPending,
            disabled: removeMember.isPending || transferOwnership.isPending,
            shouldCloseOnPress: false,
          },
        ]}
      />
    </View>
  );
}
