import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import {
  View,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@oxyhq/bloom';
import { surfaces } from '@oxyhq/bloom/surfaces';
import { useTheme } from '@oxyhq/bloom/theme';
import { Text } from '@oxyhq/bloom/typography';
import { Button } from '@oxyhq/bloom/button';
import { TextField, TextFieldInput } from '@oxyhq/bloom/text-field';
import { Divider } from '@oxyhq/bloom/divider';
import type { AccountMember, AccountRole } from '@oxyhq/core';
import type { BaseScreenProps } from '../types/navigation';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';

/** Roles assignable via invite / role change — everything except `owner`. */
type AssignableRole = Exclude<AccountRole, 'owner'>;

const ASSIGNABLE_ROLES: AssignableRole[] = ['admin', 'editor', 'developer', 'billing', 'viewer'];

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const isUserNotFound = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('user not found') || message.includes('not found');
};

/**
 * Manage the members of an account (invite by username/email, change roles,
 * remove, transfer ownership). Gated on the caller's `callerMembership`
 * permissions. Receives the target `accountId` via navigation props.
 */
const AccountMembersScreen: React.FC<BaseScreenProps> = ({ onClose, goBack, accountId }) => {
  const bloomTheme = useTheme();
  const colors = bloomTheme.colors;
  const { t } = useI18n();

  useSurfaceHeader({
    title: t('accounts.members.title') || 'Members',
    subtitle: t('accounts.members.subtitle') || 'People with access to this account.',
  });
  const { oxyServices, canUsePrivateApi } = useOxy();
  const queryClient = useQueryClient();

  const id = typeof accountId === 'string' ? accountId : '';

  const roleLabel = useCallback((role: AccountRole): string => {
    return t(`accounts.roles.${role}.label`) || role.charAt(0).toUpperCase() + role.slice(1);
  }, [t]);

  const accountQuery = useQuery({
    queryKey: ['accounts', 'detail', id],
    queryFn: () => oxyServices.getAccount(id),
    enabled: canUsePrivateApi && id.length > 0,
  });

  const callerMembership = accountQuery.data?.callerMembership ?? null;
  const permissions = callerMembership?.permissions ?? [];
  // The owner of an account (relationship 'self'/'owner') gets an implicit
  // full-permission set even when no explicit membership row exists.
  const isImplicitOwner = accountQuery.data
    ? accountQuery.data.relationship !== 'member'
    : false;
  const can = useCallback(
    (permission: string): boolean => isImplicitOwner || permissions.includes(permission),
    [isImplicitOwner, permissions],
  );

  const canRead = can('members:read');
  const canInvite = can('members:invite');
  const canUpdate = can('members:update');
  const canRemove = can('members:remove');
  const canTransfer = can('ownership:transfer');

  const membersQuery = useQuery({
    queryKey: ['accounts', 'members', id],
    queryFn: () => oxyServices.listAccountMembers(id),
    enabled: canUsePrivateApi && id.length > 0 && canRead,
  });
  const members = useMemo<AccountMember[]>(() => membersQuery.data ?? [], [membersQuery.data]);
  const ownerCount = useMemo(() => members.filter((m) => m.role === 'owner').length, [members]);

  const invalidateMembers = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['accounts', 'members', id] });
    queryClient.invalidateQueries({ queryKey: ['accounts', 'detail', id] });
  }, [queryClient, id]);

  // --- Invite form state ---
  const [inviteIdentifier, setInviteIdentifier] = useState('');
  const [inviteRole, setInviteRole] = useState<AssignableRole>('editor');
  const [inviteError, setInviteError] = useState<string | null>(null);

  const inviteMutation = useMutation({
    mutationKey: ['accounts', 'members', 'invite', id],
    mutationFn: (input: { usernameOrEmail: string; role: AssignableRole }) =>
      oxyServices.inviteAccountMember(id, input),
    onSuccess: () => {
      setInviteIdentifier('');
      setInviteRole('editor');
      setInviteError(null);
      invalidateMembers();
      toast.success(t('accounts.members.toasts.added') || 'Member added');
    },
    onError: (error) => {
      if (isUserNotFound(error)) {
        const message = t('accounts.members.errors.userNotFound') || 'User not found';
        setInviteError(message);
        toast.error(message);
        return;
      }
      toast.error(errorMessage(error, t('accounts.members.toasts.addFailed') || 'Failed to add member'));
    },
  });

  const updateMutation = useMutation({
    mutationKey: ['accounts', 'members', 'update', id],
    mutationFn: (input: { memberId: string; role: AssignableRole }) =>
      oxyServices.updateAccountMember(id, input.memberId, { role: input.role }),
    onSuccess: () => {
      invalidateMembers();
      toast.success(t('accounts.members.toasts.roleUpdated') || 'Role updated');
    },
    onError: (error) => {
      toast.error(errorMessage(error, t('accounts.members.toasts.roleFailed') || 'Failed to update role'));
    },
  });

  const removeMutation = useMutation({
    mutationKey: ['accounts', 'members', 'remove', id],
    mutationFn: (memberId: string) => oxyServices.removeAccountMember(id, memberId),
    onSuccess: () => {
      invalidateMembers();
      toast.success(t('accounts.members.toasts.removed') || 'Member removed');
    },
    onError: (error) => {
      toast.error(errorMessage(error, t('accounts.members.toasts.removeFailed') || 'Failed to remove member'));
    },
  });

  const transferMutation = useMutation({
    mutationKey: ['accounts', 'members', 'transfer', id],
    mutationFn: (userId: string) => oxyServices.transferAccountOwnership(id, { userId }),
    onSuccess: () => {
      invalidateMembers();
      toast.success(t('accounts.members.toasts.transferred') || 'Ownership transferred');
    },
    onError: (error) => {
      toast.error(errorMessage(error, t('accounts.members.toasts.transferFailed') || 'Failed to transfer ownership'));
    },
  });

  const handleInvite = useCallback(() => {
    const usernameOrEmail = inviteIdentifier.trim();
    if (!usernameOrEmail) {
      setInviteError(t('accounts.members.errors.identifierRequired') || 'Enter a username or email to invite');
      return;
    }
    setInviteError(null);
    inviteMutation.mutate({ usernameOrEmail, role: inviteRole });
  }, [inviteIdentifier, inviteRole, inviteMutation, t]);

  const handleChangeRole = useCallback((member: AccountMember, role: AccountRole) => {
    if (role === member.role || role === 'owner') {
      return;
    }
    updateMutation.mutate({ memberId: member._id, role });
  }, [updateMutation]);

  const confirmRemove = useCallback(async (member: AccountMember) => {
    const confirmed = await surfaces.confirm({
      title: t('accounts.members.removeConfirm.title') || 'Remove member',
      message:
        t('accounts.members.removeConfirm.description')
        || 'Remove this member from the account? They will lose all access.',
      confirmLabel: t('accounts.members.actions.remove') || 'Remove',
      cancelLabel: t('common.cancel') || 'Cancel',
      destructive: true,
    });
    if (confirmed) removeMutation.mutate(member._id);
  }, [removeMutation, t]);

  const confirmTransfer = useCallback(async (member: AccountMember) => {
    const confirmed = await surfaces.confirm({
      title: t('accounts.members.transferConfirm.title') || 'Transfer ownership',
      message:
        t('accounts.members.transferConfirm.description')
        || 'Transfer ownership of this account to this member? You will be demoted to admin. This cannot be undone.',
      confirmLabel: t('accounts.members.actions.transfer') || 'Transfer ownership',
      cancelLabel: t('common.cancel') || 'Cancel',
      destructive: true,
    });
    if (confirmed) transferMutation.mutate(member.memberUserId);
  }, [transferMutation, t]);

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
          {!accountQuery.isLoading && !canRead ? (
            <Text className="text-body font-body text-text-secondary text-center py-space-24">
              {t('accounts.members.errors.noPermission') || 'You do not have permission to view members.'}
            </Text>
          ) : null}

          {/* Invite form */}
          {canInvite ? (
            <View className="gap-space-12 p-space-16 rounded-radius-20 bg-fill">
              <Text className="text-body font-semibold text-text">
                {t('accounts.members.invite.title') || 'Add a member'}
              </Text>
              <TextField isInvalid={!!inviteError}>
                <TextFieldInput
                  floatingLabel
                  label={t('accounts.members.invite.identifierLabel') || 'Username or email'}
                  value={inviteIdentifier}
                  onChangeText={(value) => {
                    setInviteIdentifier(value);
                    if (inviteError) setInviteError(null);
                  }}
                  isInvalid={!!inviteError}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                />
              </TextField>
              {inviteError ? (
                <Text className="text-caption font-caption px-space-4" style={{ color: colors.negative }}>
                  {inviteError}
                </Text>
              ) : null}

              <Text className="text-caption font-caption text-text-secondary px-space-4">
                {t('accounts.members.invite.roleLabel') || 'Role'}
              </Text>
              <View className="flex-row flex-wrap gap-space-8">
                {ASSIGNABLE_ROLES.map((role) => {
                  const selected = role === inviteRole;
                  return (
                    <TouchableOpacity
                      key={role}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={roleLabel(role)}
                      onPress={() => setInviteRole(role)}
                      activeOpacity={0.7}
                      className="px-space-12 py-space-8 rounded-radius-full"
                      style={{
                        backgroundColor: selected ? colors.primary : colors.card,
                        borderWidth: 1,
                        borderColor: selected ? colors.primary : colors.border,
                      }}
                    >
                      <Text
                        className="text-caption font-semibold"
                        style={{ color: selected ? colors.background : colors.text }}
                      >
                        {roleLabel(role)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Button
                variant="primary"
                onPress={handleInvite}
                disabled={inviteMutation.isPending || !inviteIdentifier.trim()}
                loading={inviteMutation.isPending}
                accessibilityLabel={t('accounts.members.invite.submit') || 'Add member'}
                className="w-full"
              >
                {t('accounts.members.invite.submit') || 'Add member'}
              </Button>
            </View>
          ) : null}

          {/* Member list */}
          {canRead ? (
            <View className="gap-space-8">
              {membersQuery.isLoading ? (
                <View className="items-center py-space-24">
                  <ActivityIndicator color={colors.primary} />
                </View>
              ) : members.length === 0 ? (
                <Text className="text-body font-body text-text-secondary text-center py-space-24">
                  {t('accounts.members.empty') || 'No members yet.'}
                </Text>
              ) : (
                <View className="rounded-radius-20 bg-fill overflow-hidden">
                  {members.map((member, index) => {
                    const isOwner = member.role === 'owner';
                    const isLastOwner = isOwner && ownerCount <= 1;
                    const canEditThisRole = canUpdate && !isOwner;
                    const canRemoveThisMember = canRemove && !isLastOwner && (!isOwner || canTransfer);
                    const canTransferToThis = canTransfer && !isOwner && member.status === 'active';
                    return (
                      <View key={member._id}>
                        {index > 0 ? <Divider color={colors.border} spacing={0} /> : null}
                        <View className="p-space-16 gap-space-8">
                          <View className="flex-row items-center gap-space-8">
                            <Text className="text-body font-semibold text-text flex-1" numberOfLines={1}>
                              {member.memberUserId}
                            </Text>
                            {isOwner ? (
                              <View className="px-space-8 py-space-4 rounded-radius-full" style={{ backgroundColor: colors.primarySubtle }}>
                                <Text className="text-caption font-semibold" style={{ color: colors.primary }}>
                                  {roleLabel('owner')}
                                </Text>
                              </View>
                            ) : null}
                            {member.status !== 'active' ? (
                              <View className="px-space-8 py-space-4 rounded-radius-full" style={{ backgroundColor: colors.card }}>
                                <Text className="text-caption font-caption capitalize text-text-secondary">
                                  {member.status}
                                </Text>
                              </View>
                            ) : null}
                          </View>

                          {/* Role chips (editable) or static role label */}
                          {canEditThisRole ? (
                            <View className="flex-row flex-wrap gap-space-8">
                              {ASSIGNABLE_ROLES.map((role) => {
                                const selected = role === member.role;
                                return (
                                  <TouchableOpacity
                                    key={role}
                                    accessibilityRole="radio"
                                    accessibilityState={{ selected }}
                                    accessibilityLabel={roleLabel(role)}
                                    onPress={() => handleChangeRole(member, role)}
                                    disabled={updateMutation.isPending}
                                    activeOpacity={0.7}
                                    className="px-space-12 py-space-4 rounded-radius-full"
                                    style={{
                                      backgroundColor: selected ? colors.primary : colors.card,
                                      borderWidth: 1,
                                      borderColor: selected ? colors.primary : colors.border,
                                    }}
                                  >
                                    <Text
                                      className="text-caption font-semibold"
                                      style={{ color: selected ? colors.background : colors.text }}
                                    >
                                      {roleLabel(role)}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              })}
                            </View>
                          ) : !isOwner ? (
                            <Text className="text-caption font-caption text-text-secondary">
                              {roleLabel(member.role)}
                            </Text>
                          ) : null}

                          {/* Actions */}
                          {(canTransferToThis || canRemoveThisMember) ? (
                            <View className="flex-row gap-space-16 pt-space-4">
                              {canTransferToThis ? (
                                <TouchableOpacity
                                  accessibilityRole="button"
                                  accessibilityLabel={t('accounts.members.actions.transfer') || 'Transfer ownership'}
                                  onPress={() => confirmTransfer(member)}
                                  activeOpacity={0.7}
                                  className="flex-row items-center gap-space-4"
                                >
                                  <Ionicons name="swap-horizontal-outline" size={16} color={colors.icon} />
                                  <Text className="text-caption font-semibold text-text-secondary">
                                    {t('accounts.members.actions.transfer') || 'Transfer ownership'}
                                  </Text>
                                </TouchableOpacity>
                              ) : null}
                              {canRemoveThisMember ? (
                                <TouchableOpacity
                                  accessibilityRole="button"
                                  accessibilityLabel={t('accounts.members.actions.remove') || 'Remove member'}
                                  onPress={() => confirmRemove(member)}
                                  activeOpacity={0.7}
                                  className="flex-row items-center gap-space-4"
                                >
                                  <Ionicons name="trash-outline" size={16} color={colors.error} />
                                  <Text className="text-caption font-semibold" style={{ color: colors.error }}>
                                    {t('accounts.members.actions.remove') || 'Remove'}
                                  </Text>
                                </TouchableOpacity>
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
