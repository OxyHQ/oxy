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
import { createTokenStyles } from '@oxy.so/bloom/theme';

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
  const styles = useStyles();
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
        <View style={styles.centered}>
          <Text style={styles.mutedText}>
            {t('accounts.members.errors.missingAccount') || 'No account selected.'}
          </Text>
        </View>
      </>
    );
  }

  return (
    <View style={styles.container}>
      {!accountView.isLoading && !canRead ? (
        <Text style={styles.mutedText2}>
          {t('accounts.members.errors.noPermission') ||
            'You do not have permission to view members.'}
        </Text>
      ) : null}

      {/* Invite form */}
      {canInvite ? (
        <View style={styles.surface}>
          <Text style={styles.title}>{t('accounts.members.invite.title')}</Text>
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
            <Text style={[styles.text, { color: colors.negative }]}>{inviteError}</Text>
          ) : null}

          <Text style={styles.mutedText3}>{t('accounts.members.invite.roleLabel') || 'Role'}</Text>
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
            style={styles.button}
          >
            {t('accounts.members.invite.submit')}
          </Button>
        </View>
      ) : null}

      {canRead ? (
        <View style={styles.stack}>
          <Text style={styles.title}>Pending invitations</Text>
          {invitations.status === 'error' ? <Text>Could not load invitations.</Text> : null}
          {(invitations.value?.invitations ?? []).map((invitation) => (
            <View key={invitation.id} style={styles.surface2}>
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
        <View style={styles.stack2}>
          {roster.isLoading ? (
            <View style={styles.container2}>{null}</View>
          ) : members.length === 0 ? (
            <Text style={styles.mutedText2}>
              {t('accounts.members.empty') || 'No members yet.'}
            </Text>
          ) : (
            <View style={styles.surface3}>
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
                    <View style={styles.stack3}>
                      <View style={styles.row}>
                        <Text style={styles.text2} numberOfLines={1}>
                          <MemberName userId={member.memberUserId} />
                        </Text>
                        {isOwner ? (
                          <View style={[styles.section, { backgroundColor: colors.primarySubtle }]}>
                            <Text style={[styles.title2, { color: colors.primary }]}>
                              {roleLabel('owner')}
                            </Text>
                          </View>
                        ) : null}
                        {!isEditableHere ? (
                          <View style={[styles.section, { backgroundColor: colors.card }]}>
                            <Text style={styles.mutedText4}>
                              {t('accounts.members.inherited') || 'Inherited'}
                            </Text>
                          </View>
                        ) : null}
                        {member.status !== 'active' ? (
                          <View style={[styles.section, { backgroundColor: colors.card }]}>
                            <Text style={styles.mutedText5}>{member.status}</Text>
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
                        <Text style={styles.mutedText4}>{roleLabel(member.role)}</Text>
                      ) : null}

                      {/* Actions */}
                      {canTransferToThis || canRemoveThisMember ? (
                        <View style={styles.row2}>
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
                              style={styles.button2}
                            >
                              <Ionicons
                                name="swap-horizontal-outline"
                                size={16}
                                color={colors.icon}
                              />
                              <Text style={styles.mutedText6}>
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
                              style={styles.button2}
                            >
                              <Ionicons name="trash-outline" size={16} color={colors.error} />
                              <Text style={[styles.title2, { color: colors.error }]}>
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

const useStyles = createTokenStyles((t) => ({
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 40,
  },
  mutedText: {
    textAlign: 'center',
    fontSize: 15,
    color: t.mutedForeground,
    lineHeight: 22,
    fontWeight: 400,
  },
  container: { gap: 24, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32 },
  mutedText2: {
    paddingVertical: 24,
    textAlign: 'center',
    fontSize: 15,
    color: t.mutedForeground,
    lineHeight: 22,
    fontWeight: 400,
  },
  surface: { gap: 12, borderRadius: 20, backgroundColor: t.card, padding: 16 },
  title: { fontWeight: 600, color: t.foreground, lineHeight: 22 },
  text: { paddingHorizontal: 4, fontSize: 11, lineHeight: 14, fontWeight: 400 },
  mutedText3: {
    paddingHorizontal: 4,
    fontSize: 11,
    color: t.mutedForeground,
    lineHeight: 14,
    fontWeight: 400,
  },
  button: { width: '100%' },
  stack: { gap: 12 },
  surface2: { gap: 8, borderRadius: 20, backgroundColor: t.card, padding: 16 },
  stack2: { gap: 8 },
  container2: { alignItems: 'center', paddingVertical: 24 },
  surface3: { overflow: 'hidden', borderRadius: 20, backgroundColor: t.card },
  stack3: { gap: 8, padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  text2: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 15,
    color: t.foreground,
    lineHeight: 22,
    fontWeight: 400,
  },
  section: { paddingHorizontal: 8, paddingVertical: 4 },
  title2: { fontWeight: 600, lineHeight: 14 },
  mutedText4: { fontSize: 11, color: t.mutedForeground, lineHeight: 14, fontWeight: 400 },
  mutedText5: {
    fontSize: 11,
    color: t.mutedForeground,
    textTransform: 'capitalize',
    lineHeight: 14,
    fontWeight: 400,
  },
  row2: { flexDirection: 'row', gap: 16, paddingTop: 4 },
  button2: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  mutedText6: { fontWeight: 600, color: t.mutedForeground, lineHeight: 14 },
}));
