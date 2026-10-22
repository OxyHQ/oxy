import { getNormalizedUserHandle } from '@oxy.so/core';
import type { AccountInvitation } from '@oxy.so/core';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiDeleteBin6Line } from '@oxy.so/bloom/icons/RiDeleteBin6Line';
import { RiExchangeLine } from '@oxy.so/bloom/icons/RiExchangeLine';
import { RiMailLine } from '@oxy.so/bloom/icons/RiMailLine';
import { RiVipCrownLine } from '@oxy.so/bloom/icons/RiVipCrownLine';
import { Textarea } from '@oxy.so/bloom/textarea';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useTheme } from '@oxy.so/bloom/theme';
import { useAuth } from '@oxy.so/services/ui/client';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { ConfirmDialog } from '@/components/account-pages/ConfirmDialog';
import { OptionSelect } from '@/components/account-pages/OptionSelect';
import { PageFrame } from '@/components/account-pages/PageFrame';
import { Field, Muted, Panel, Section } from '@/components/account-pages/Section';
import { SkeletonRows } from '@/components/account-pages/Skeletons';
import { StatusBadge } from '@/components/account-pages/StatusBadge';
import { AccountAvatarField } from '@/components/settings/AccountAvatarField';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import {
  accountInitials,
  resolveStoredImageUrl,
  useAccountLabels,
} from '@/components/settings/account-labels';
import { LanguagePicker } from '@/components/settings/language-picker';
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

export default function AccountSettingsPage() {
  const { t } = useTranslation();
  const labels = useAccountLabels();
  const router = useRouter();
  const theme = useTheme();
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
    return (
      <PageFrame title={t('settingsPage.title')} headerExtra={<SettingsTabs active="account" />}>
        <View className="px-6 py-12 items-center">
          <Muted>{t('common.loading')}</Muted>
        </View>
      </PageFrame>
    );
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
      router.navigate('/dashboard');
    } catch (error) {
      // The API returns 409 when the account still owns applications.
      toast.error(getErrorMessage(error, t('settingsPage.archive.failed')));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <PageFrame
      title={t('settingsPage.title')}
      subtitle={label}
      headerExtra={<SettingsTabs active="account" />}
    >
      {/* General */}
      <Section title={t('settingsPage.general.title')}>
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
                <View className="min-w-0 flex-1">
                  <Text className="text-xs text-muted-foreground">
                    {t('settingsPage.general.personalAvatar')}{' '}
                    <Text
                      accessibilityRole="link"
                      className="font-medium text-foreground underline"
                      onPress={() => void Linking.openURL(config.accountsUrl)}
                    >
                      {t('settingsPage.general.managedInOxy')}
                    </Text>
                  </Text>
                </View>
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
            hint={isPersonal ? t('settingsPage.general.personalNameLocked') : undefined}
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
              <Text className="font-mono text-sm text-muted-foreground">
                @{accountUser.username}
              </Text>
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
      </Section>

      {/* Language */}
      <Section title={t('settings.language.title')} description={t('settings.language.subtitle')}>
        <LanguagePicker />
      </Section>

      {/* Members */}
      {!isPersonal && (
        <Section
          title={t('settingsPage.members.title')}
          action={
            canManage ? (
              <Button size="sm" leadingIcon={RiAddLine} onPress={() => setShowInviteDialog(true)}>
                {t('settingsPage.members.invite')}
              </Button>
            ) : undefined
          }
        >
          {membersQuery.isLoading ? (
            <SkeletonRows height={56} />
          ) : activeMembers.length === 0 ? (
            <View className="items-center py-8">
              <Muted>{t('settingsPage.members.none')}</Muted>
            </View>
          ) : (
            <View className="gap-2">
              {activeMembers.map((member) => {
                const isOwner = member.role === 'owner';
                const isLastOwner = isOwner && ownerCount <= 1;
                // An INHERITED entry's row lives on an ancestor account, and every
                // member mutation is scoped to rows on the account in the path — so
                // offering to edit, remove or promote one would be offering a
                // request the server answers 404. It is changed where it lives, on
                // that ancestor's own members screen.
                const isEditableHere = (member.source ?? 'direct') === 'direct';
                const canEditThisRole = canManage && isEditableHere && !isOwner;
                const canRemoveThisMember = canManage && isEditableHere && !isOwner && !isLastOwner;
                const canTransferToThis = canTransfer && isEditableHere && !isOwner;

                return (
                  <View
                    key={member._id}
                    className="flex-row flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
                  >
                    <View className="min-w-0 flex-row items-center gap-3">
                      <Avatar
                        size={32}
                        initials={member.memberUserId[0]?.toUpperCase() ?? '?'}
                        alt={member.memberUserId}
                      />
                      <View className="min-w-0">
                        <Text className="font-mono text-sm text-foreground" numberOfLines={1}>
                          {shortUserId(member.memberUserId)}
                        </Text>
                        <Text className="text-xs text-muted-foreground">
                          {labels.role(member.role)}
                        </Text>
                      </View>
                    </View>
                    <View className="flex-row items-center gap-2">
                      {!isEditableHere ? (
                        <StatusBadge
                          variant="outline"
                          label={t('settingsPage.members.inherited')}
                        />
                      ) : null}
                      {isOwner ? (
                        <View className="flex-row items-center gap-1">
                          <RiVipCrownLine size="xs" fill={theme.colors.textSecondary} />
                          <StatusBadge label={labels.role('owner')} />
                        </View>
                      ) : canEditThisRole ? (
                        <View className="w-36">
                          <OptionSelect
                            label={t('settingsPage.members.role')}
                            value={member.role as AssignableAccountRole}
                            options={roleOptions}
                            onChange={(role) => void handleRoleChange(member, role)}
                          />
                        </View>
                      ) : (
                        <StatusBadge variant="outline" label={labels.role(member.role)} />
                      )}
                      {canTransferToThis && (
                        <Button
                          appearance="plain"
                          size="sm"
                          iconOnly
                          leadingIcon={RiExchangeLine}
                          accessibilityLabel={t('settingsPage.members.transfer')}
                          onPress={() => setMemberToPromote(member)}
                        />
                      )}
                      {canRemoveThisMember && (
                        <Button
                          appearance="plain"
                          tone="danger"
                          size="sm"
                          iconOnly
                          leadingIcon={RiCloseLine}
                          accessibilityLabel={t('settingsPage.members.remove')}
                          onPress={() => void handleRemoveMember(member)}
                        />
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          {/* Pending invitations */}
          {pendingInvites.length > 0 && (
            <View className="mt-4 gap-3 border-t border-border pt-4">
              <Text className="text-sm font-medium text-muted-foreground">
                {t('settingsPage.invitations.title')}
              </Text>
              <View className="gap-2">
                {pendingInvites.map((invite) => (
                  <View
                    key={invite.id}
                    className="flex-row flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border px-4 py-3"
                  >
                    <View className="min-w-0 flex-1 flex-row items-center gap-3">
                      <View className="size-8 items-center justify-center rounded-full bg-muted">
                        <RiMailLine size="xs" fill={theme.colors.textSecondary} />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className="font-mono text-sm text-foreground" numberOfLines={1}>
                          {invite.email}
                        </Text>
                        <Text className="text-xs text-muted-foreground">
                          {invite.status} • {labels.role(invite.role)}
                          {invite.createdAt
                            ? ` • ${new Date(invite.createdAt).toLocaleDateString()}`
                            : ''}
                        </Text>
                      </View>
                    </View>
                    {canManage && (
                      <View className="flex-row items-center gap-1">
                        <Button
                          appearance="plain"
                          size="sm"
                          onPress={() => void handleResendInvite(invite)}
                        >
                          {t('settingsPage.invitations.resend')}
                        </Button>
                        <Button
                          appearance="plain"
                          size="sm"
                          onPress={() => void handleCancelInvite(invite)}
                        >
                          {t('common.cancel')}
                        </Button>
                      </View>
                    )}
                  </View>
                ))}
              </View>
            </View>
          )}
        </Section>
      )}

      {/* Billing — account billing isn't a backend concept here; the dedicated Billing page covers it. */}
      <Section title={t('settingsPage.billing.title')} last={!canDelete}>
        <Panel>
          <View className="flex-row flex-wrap items-center justify-between gap-3">
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-sm font-medium text-foreground">
                {t('settingsPage.billing.heading')}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t('settingsPage.billing.body')}
              </Text>
            </View>
            <Button appearance="outline" size="sm" onPress={() => router.navigate('/billing')}>
              {t('settingsPage.billing.manage')}
            </Button>
          </View>
        </Panel>
      </Section>

      {/* Danger zone */}
      {canDelete && (
        <Section title={t('settingsPage.archive.zone')} tone="danger" last>
          <View className="rounded-lg border border-destructive bg-destructive/5 p-4">
            <View className="flex-row flex-wrap items-center justify-between gap-3">
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-sm font-medium text-foreground">
                  {t('settingsPage.archive.heading')}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  {t('settingsPage.archive.body')}
                </Text>
              </View>
              <Button
                tone="danger"
                size="sm"
                leadingIcon={RiDeleteBin6Line}
                onPress={() => setShowDeleteDialog(true)}
              >
                {t('settingsPage.archive.action')}
              </Button>
            </View>
          </View>
        </Section>
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
            hint={t(`settingsPage.roleDescriptions.${inviteRole}`)}
          >
            <OptionSelect
              label={t('settingsPage.members.role')}
              value={inviteRole}
              options={roleOptions}
              onChange={setInviteRole}
            />
          </Field>
        </View>
      </Dialog>

      {/* Transfer ownership confirmation */}
      <ConfirmDialog
        open={memberToPromote !== null}
        title={t('settingsPage.members.transfer')}
        description={t('settingsPage.members.transferBody')}
        confirmLabel={
          transferOwnershipMutation.isPending
            ? t('settingsPage.members.transferring')
            : t('settingsPage.members.transfer')
        }
        loading={transferOwnershipMutation.isPending}
        onConfirm={() => void handleTransfer()}
        onClose={() => setMemberToPromote(null)}
      />

      {/* Archive confirmation */}
      <ConfirmDialog
        open={showDeleteDialog}
        title={t('settingsPage.archive.action')}
        description={t('settingsPage.archive.confirmBody', { name: label })}
        confirmLabel={
          isDeleting ? t('settingsPage.archive.archiving') : t('settingsPage.archive.confirmAction')
        }
        destructive
        loading={isDeleting}
        disabled={deleteConfirmation !== label}
        onConfirm={() => void handleDelete()}
        onClose={() => {
          setShowDeleteDialog(false);
          setDeleteConfirmation('');
        }}
      >
        <View className="gap-2 py-2">
          <Text className="text-sm text-foreground">
            {t('settingsPage.archive.typeToConfirm', { name: label })}
          </Text>
          <TextFieldInput
            label={t('settingsPage.archive.confirmLabel')}
            value={deleteConfirmation}
            onChangeText={setDeleteConfirmation}
            placeholder={label}
          />
        </View>
      </ConfirmDialog>
    </PageFrame>
  );
}
