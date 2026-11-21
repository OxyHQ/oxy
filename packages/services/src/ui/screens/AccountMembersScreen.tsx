import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Ionicons from '../icons/Ionicons';
import { skip, useAction, useEntity, useList, useRecord } from '@oxy.so/bloom-data';
import { toast } from '@oxy.so/bloom/toast';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Divider } from '@oxy.so/bloom/divider';
import { checkContract, emailAddressCheck } from '@oxy.so/contracts/client';
import type { AccountMember, AccountRole } from '@oxy.so/core';
import { accountRoleLabel, getNormalizedUserHandle } from '@oxy.so/core';
import type { BaseScreenProps } from '../types/navigation';
import { useOxy } from '../context/oxyRuntimeContext';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useApiErrorToast } from '../hooks/useApiErrorToast';
import { withoutWhitespace } from '../utils/withoutWhitespace';
import {
  type AssignableRole,
  accountInvitations,
  accountNode,
  accountRoster,
  changeInvitation,
  inviteMember,
  memberProfiles,
  removeMember,
  transferOwnership,
  updateMemberRole,
} from '../data/account';
import { User } from '../data/user';
import type { CachedUser } from '../data/userRecord';

const ASSIGNABLE_ROLES: AssignableRole[] = ['admin', 'editor', 'developer', 'billing', 'viewer'];

const handleOf = (user: CachedUser | undefined) => getNormalizedUserHandle(user);

/** A member's handle from `User`, or their id while no handle is known. */
function MemberName({ userId }: { userId: string }) {
  const handle = useEntity(User, userId, handleOf);
  return <>{handle ?? userId}</>;
}

/**
 * Manage the members of an account (invite by email, change roles,
 * remove, transfer ownership). Gated on the caller's `callerMembership`
 * permissions. Receives the target `accountId` via navigation props.
 */
const AccountMembersScreen: React.FC<BaseScreenProps> = ({ onClose, goBack, accountId }) => {
  const bloomTheme = useTheme();
  const colors = bloomTheme.colors;
  const { t, locale } = useI18n();
  const showApiError = useApiErrorToast();

  useSurfaceHeader({
    title: t('accounts.members.title') || 'Members',
    subtitle: t('accounts.members.subtitle') || 'People with access to this account.',
  });
  const { oxyServices, canUsePrivateApi, accounts } = useOxy();

  const id = typeof accountId === 'string' ? accountId : '';

  const roleLabel = useCallback(
    (role: AccountRole): string => accountRoleLabel(locale, role),
    [locale],
  );

  const accountView = useRecord(
    accountNode,
    ...(canUsePrivateApi && id.length > 0 ? ([oxyServices, id] as const) : [skip]),
  );
  // Until it is read, the node the session's account list holds.
  const account = accountView.value ?? accounts?.find((entry) => entry.accountId === id);

  const callerMembership = account?.callerMembership ?? null;
  const permissions = callerMembership?.permissions ?? [];
  // The owner of an account (relationship 'self'/'owner') gets an implicit
  // full-permission set even when no explicit membership row exists.
  const isImplicitOwner = account ? account.relationship !== 'member' : false;
  const can = useCallback(
    (permission: string): boolean => isImplicitOwner || permissions.includes(permission),
    [isImplicitOwner, permissions],
  );

  const canRead = can('members:read');
  const canInvite = can('members:invite');
  const canUpdate = can('members:update');
  const canRemove = can('members:remove');
  const canTransfer = can('ownership:transfer');

  const readable = canUsePrivateApi && id.length > 0 && canRead;
  const roster = useRecord(accountRoster, ...(readable ? ([oxyServices, id] as const) : [skip]));
  const invitations = useRecord(
    accountInvitations,
    ...(readable ? ([oxyServices, id] as const) : [skip]),
  );
  const invitationAction = useAction(changeInvitation);
  const { run: runInvitationAction } = invitationAction;
  const changeInvitationStatus = useCallback(
    (invitationId: string, change: 'resend' | 'cancel') => {
      runInvitationAction(oxyServices, id, invitationId, change).catch((error: unknown) =>
        showApiError(error, 'accounts.members.toasts.invitationUpdateFailed'),
      );
    },
    [runInvitationAction, oxyServices, id, showApiError],
  );
  const members = useMemo<readonly AccountMember[]>(
    () => roster.value?.members ?? [],
    [roster.value?.members],
  );
  const memberUserIds = useMemo(
    () => [...new Set(members.map((member) => member.memberUserId).filter((id) => id.length > 0))],
    [members],
  );
  // Reads the members' profiles into `User`, where each row's name is read.
  useList(
    memberProfiles,
    ...(canUsePrivateApi && memberUserIds.length > 0
      ? ([oxyServices, memberUserIds] as const)
      : [skip]),
  );
  // DIRECT owners only. The list also carries members whose row lives on an
  // ancestor, and the last-owner rule this count feeds is about the rows on THIS
  // account — the server's guard counts those. Including an inherited owner
  // would make a child that has no owner of its own look like it has exactly
  // one, and silently disable removing anybody.
  const ownerCount = useMemo(
    () => members.filter((m) => m.role === 'owner' && (m.source ?? 'direct') === 'direct').length,
    [members],
  );

  // --- Invite form state ---
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<AssignableRole>('editor');
  const [inviteError, setInviteError] = useState<string | null>(null);

  const inviteMutation = useAction(inviteMember);
  const updateMutation = useAction(updateMemberRole);
  const removeMutation = useAction(removeMember);
  const transferMutation = useAction(transferOwnership);
  const { run: invite } = inviteMutation;
  const { run: updateRole } = updateMutation;
  const { run: remove } = removeMutation;
  const { run: transfer } = transferMutation;

  const handleInvite = useCallback(() => {
    // The contract `POST /accounts/:id/invitations` holds the address to.
    const email = checkContract(emailAddressCheck, inviteEmail);
    if (email === null) {
      setInviteError(t('accounts.members.errors.emailInvalid'));
      return;
    }
    setInviteError(null);
    invite(oxyServices, id, { email, role: inviteRole }).then(
      () => {
        setInviteEmail('');
        setInviteRole('editor');
        setInviteError(null);
        toast.success(t('accounts.members.toasts.invited'));
      },
      (error: unknown) => showApiError(error, 'accounts.members.toasts.inviteFailed'),
    );
  }, [inviteEmail, inviteRole, invite, oxyServices, id, showApiError, t]);

  const handleChangeRole = useCallback(
    (member: AccountMember, role: AccountRole) => {
      if (role === member.role || role === 'owner') {
        return;
      }
      updateRole(oxyServices, id, member._id, role).then(
        () => toast.success(t('accounts.members.toasts.roleUpdated') || 'Role updated'),
        (error: unknown) => showApiError(error, 'accounts.members.toasts.roleFailed'),
      );
    },
    [updateRole, oxyServices, id, showApiError, t],
  );

  const confirmRemove = useCallback(
    async (member: AccountMember) => {
      const confirmed = await surfaces.confirm({
        title: t('accounts.members.removeConfirm.title') || 'Remove member',
        description:
          t('accounts.members.removeConfirm.description') ||
          'Remove this member from the account? They will lose all access.',
        confirmLabel: t('accounts.members.actions.remove') || 'Remove',
        cancelLabel: t('common.cancel') || 'Cancel',
        destructive: true,
      });
      if (!confirmed) return;
      remove(oxyServices, id, member._id).then(
        () => toast.success(t('accounts.members.toasts.removed') || 'Member removed'),
        (error: unknown) => showApiError(error, 'accounts.members.toasts.removeFailed'),
      );
    },
    [remove, oxyServices, id, showApiError, t],
  );

  const confirmTransfer = useCallback(
    async (member: AccountMember) => {
      const confirmed = await surfaces.confirm({
        title: t('accounts.members.transferConfirm.title') || 'Transfer ownership',
        description:
          t('accounts.members.transferConfirm.description') ||
          'Transfer ownership of this account to this member? You will be demoted to admin. This cannot be undone.',
        confirmLabel: t('accounts.members.actions.transfer') || 'Transfer ownership',
        cancelLabel: t('common.cancel') || 'Cancel',
        destructive: true,
      });
      if (!confirmed) return;
      transfer(oxyServices, id, member.memberUserId).then(
        () => toast.success(t('accounts.members.toasts.transferred') || 'Ownership transferred'),
        (error: unknown) => showApiError(error, 'accounts.members.toasts.transferFailed'),
      );
    },
    [transfer, oxyServices, id, showApiError, t],
  );

  if (!id) {
    return (
      <>
        <View className="items-center justify-center px-screen-margin py-space-40">
          <Text className="text-body font-body text-text-secondary text-center">
            {t('accounts.members.errors.missingAccount') || 'No account selected.'}
          </Text>
        </View>
      </>
    );
  }

  return (
    <View className="px-screen-margin pt-space-16 pb-space-32 gap-space-24">
      {!accountView.isLoading && !canRead ? (
        <Text className="text-body font-body text-text-secondary text-center py-space-24">
          {t('accounts.members.errors.noPermission') ||
            'You do not have permission to view members.'}
        </Text>
      ) : null}

      {/* Invite form */}
      {canInvite ? (
        <View className="gap-space-12 p-space-16 rounded-radius-20 bg-fill">
          <Text className="text-body font-semibold text-text">
            {t('accounts.members.invite.title')}
          </Text>
          <TextField isInvalid={!!inviteError}>
            <TextFieldInput
              floatingLabel
              label={t('accounts.members.invite.emailLabel')}
              value={inviteEmail}
              onChangeText={(value) => {
                setInviteEmail(withoutWhitespace(value));
                if (inviteError) setInviteError(null);
              }}
              isInvalid={!!inviteError}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              keyboardType="email-address"
            />
          </TextField>
          {inviteError ? (
            <Text
              className="text-caption font-caption px-space-4"
              style={{ color: colors.negative }}
            >
              {inviteError}
            </Text>
          ) : null}

          <Text className="text-caption font-caption text-text-secondary px-space-4">
            {t('accounts.members.invite.roleLabel') || 'Role'}
          </Text>
          <SegmentedControl
            type="radio"
            label={t('accounts.members.invite.roleLabel') || 'Role'}
            value={inviteRole}
            onValueChange={setInviteRole}
            size="sm"
          >
            {ASSIGNABLE_ROLES.map((role) => (
              <SegmentedControlItem key={role} value={role}>
                <SegmentedControlItemText>{roleLabel(role)}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>

          <Button
            appearance="solid"
            tone="accent"
            onPress={handleInvite}
            disabled={inviteMutation.isPending || !inviteEmail}
            loading={inviteMutation.isPending}
            accessibilityLabel={t('accounts.members.invite.submit')}
            className="w-full"
          >
            {t('accounts.members.invite.submit')}
          </Button>
        </View>
      ) : null}

      {canRead ? (
        <View className="gap-space-12">
          <Text className="text-body font-semibold text-text">Pending invitations</Text>
          {invitations.status === 'error' ? <Text>Could not load invitations.</Text> : null}
          {(invitations.value?.invitations ?? []).map((invitation) => (
            <View key={invitation.id} className="gap-space-8 p-space-16 rounded-radius-20 bg-fill">
              <Text>
                {invitation.email} · {roleLabel(invitation.role)} · {invitation.status}
              </Text>
              <Text>Expires {new Date(invitation.expiresAt).toLocaleDateString()}</Text>
              {canInvite ? (
                <Button
                  disabled={invitationAction.isPending}
                  onPress={() => changeInvitationStatus(invitation.id, 'resend')}
                >
                  Resend
                </Button>
              ) : null}
              {canRemove ? (
                <Button
                  disabled={invitationAction.isPending}
                  onPress={() => changeInvitationStatus(invitation.id, 'cancel')}
                >
                  Cancel invitation
                </Button>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {/* Member list */}
      {canRead ? (
        <View className="gap-space-8">
          {roster.isLoading ? (
            <View className="items-center py-space-24">{null}</View>
          ) : members.length === 0 ? (
            <Text className="text-body font-body text-text-secondary text-center py-space-24">
              {t('accounts.members.empty') || 'No members yet.'}
            </Text>
          ) : (
            <View className="rounded-radius-20 bg-fill overflow-hidden">
              {members.map((member, index) => {
                const isOwner = member.role === 'owner';
                const isLastOwner = isOwner && ownerCount <= 1;
                // An INHERITED entry's row lives on an ancestor account, and
                // every member mutation is scoped to rows on the account in
                // the path — so offering to edit, remove or promote one would
                // be offering a request the server answers 404. The row is
                // changed where it lives, on that ancestor's own member
                // screen.
                const isEditableHere = (member.source ?? 'direct') === 'direct';
                const canEditThisRole = canUpdate && isEditableHere && !isOwner;
                const canRemoveThisMember =
                  canRemove && isEditableHere && !isLastOwner && (!isOwner || canTransfer);
                const canTransferToThis =
                  canTransfer && isEditableHere && !isOwner && member.status === 'active';
                return (
                  <View key={member._id}>
                    {index > 0 ? <Divider color={colors.border} spacing={0} /> : null}
                    <View className="p-space-16 gap-space-8">
                      <View className="flex-row items-center gap-space-8">
                        <Text
                          className="text-body font-bodyBold text-text flex-1"
                          numberOfLines={1}
                        >
                          <MemberName userId={member.memberUserId} />
                        </Text>
                        {isOwner ? (
                          <View
                            className="px-space-8 py-space-4 rounded-radius-full"
                            style={{ backgroundColor: colors.primarySubtle }}
                          >
                            <Text
                              className="text-caption font-semibold"
                              style={{ color: colors.primary }}
                            >
                              {roleLabel('owner')}
                            </Text>
                          </View>
                        ) : null}
                        {!isEditableHere ? (
                          <View
                            className="px-space-8 py-space-4 rounded-radius-full"
                            style={{ backgroundColor: colors.card }}
                          >
                            <Text className="text-caption font-caption text-text-secondary">
                              {t('accounts.members.inherited') || 'Inherited'}
                            </Text>
                          </View>
                        ) : null}
                        {member.status !== 'active' ? (
                          <View
                            className="px-space-8 py-space-4 rounded-radius-full"
                            style={{ backgroundColor: colors.card }}
                          >
                            <Text className="text-caption font-caption capitalize text-text-secondary">
                              {member.status}
                            </Text>
                          </View>
                        ) : null}
                      </View>

                      {/* Role chips (editable) or static role label */}
                      {canEditThisRole ? (
                        <SegmentedControl
                          type="radio"
                          label={t('accounts.members.invite.roleLabel') || 'Role'}
                          value={member.role}
                          onValueChange={(role) => handleChangeRole(member, role)}
                          disabled={updateMutation.isPending}
                          size="sm"
                        >
                          {ASSIGNABLE_ROLES.map((role) => (
                            <SegmentedControlItem key={role} value={role}>
                              <SegmentedControlItemText>{roleLabel(role)}</SegmentedControlItemText>
                            </SegmentedControlItem>
                          ))}
                        </SegmentedControl>
                      ) : !isOwner ? (
                        <Text className="text-caption font-caption text-text-secondary">
                          {roleLabel(member.role)}
                        </Text>
                      ) : null}

                      {/* Actions */}
                      {canTransferToThis || canRemoveThisMember ? (
                        <View className="flex-row gap-space-16 pt-space-4">
                          {canTransferToThis ? (
                            <Button
                              appearance="plain"
                              tone="neutral"
                              size="sm"
                              accessibilityRole="button"
                              accessibilityLabel={
                                t('accounts.members.actions.transfer') || 'Transfer ownership'
                              }
                              onPress={() => confirmTransfer(member)}
                              className="flex-row items-center gap-space-4"
                            >
                              <Ionicons
                                name="swap-horizontal-outline"
                                size={16}
                                color={colors.icon}
                              />
                              <Text className="text-caption font-semibold text-text-secondary">
                                {t('accounts.members.actions.transfer') || 'Transfer ownership'}
                              </Text>
                            </Button>
                          ) : null}
                          {canRemoveThisMember ? (
                            <Button
                              appearance="plain"
                              tone="neutral"
                              size="sm"
                              accessibilityRole="button"
                              accessibilityLabel={
                                t('accounts.members.actions.remove') || 'Remove member'
                              }
                              onPress={() => confirmRemove(member)}
                              className="flex-row items-center gap-space-4"
                            >
                              <Ionicons name="trash-outline" size={16} color={colors.error} />
                              <Text
                                className="text-caption font-semibold"
                                style={{ color: colors.error }}
                              >
                                {t('accounts.members.actions.remove') || 'Remove'}
                              </Text>
                            </Button>
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
};

export default AccountMembersScreen;
