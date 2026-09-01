import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { useAuth } from '@oxyhq/services';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  ArrowDataTransferHorizontalIcon,
  ArrowLeft01Icon,
  Cancel01Icon,
  CrownIcon,
  Delete02Icon,
  Mail01Icon,
  UserMultiple02Icon,
} from '@hugeicons/core-free-icons';
import { toast } from '@oxyhq/bloom/toast';
import type { AccountMember, AccountRole, AssignableAccountRole } from '@/hooks/use-account';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ImageUploadField } from '@/components/ui/image-upload-field';
import config from '@/lib/config';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useAccount,
  useAccountMembers,
  useInviteAccountMember,
  useRemoveAccountMember,
  useTransferAccountOwnership,
  useUpdateAccountMember,
} from '@/hooks/use-account';
import {
  USER_NOT_FOUND_MESSAGE,
  getErrorMessage,
  isUserNotFoundError,
} from '@/lib/api-error';
import { stripSensitiveImageUrlQueryParams } from '@/lib/image-upload';

export const Route = createFileRoute('/_layout/settings/account')({
  component: AccountSettingsPage,
});

const roleLabels: Record<AccountRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  developer: 'Developer',
  billing: 'Billing',
  viewer: 'Viewer',
};

const roleDescriptions: Record<AssignableAccountRole, string> = {
  admin: 'Can manage members and settings',
  editor: 'Can create and edit apps and content',
  developer: 'Can manage apps, credentials, and webhooks',
  billing: 'Can manage billing',
  viewer: 'Read-only access',
};

const ASSIGNABLE_ROLES: Array<AssignableAccountRole> = ['admin', 'editor', 'developer', 'billing', 'viewer'];

/** Short, readable handle for a member identified only by user id. */
function shortUserId(userId: string): string {
  return userId.length > 10 ? `${userId.slice(0, 6)}…${userId.slice(-4)}` : userId;
}

function AccountSettingsPage() {
  const navigate = useNavigate();
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
  // back to the handle. Used in the header and delete confirmation.
  const accountLabel =
    accountUser?.name?.displayName ?? getNormalizedUserHandle(accountUser) ?? '';

  // Personal accounts show the signed-in user's avatar (read-only — it is
  // managed in the user's Oxy account). Resolved the same way as `nav-user.tsx`.
  const userAvatarUrl = ((): string | undefined => {
    if (!user?.avatar) return undefined;
    if (user.avatar.startsWith('http')) return user.avatar;
    return oxyServices.getFileDownloadUrl(user.avatar, 'thumb');
  })();

  const userInitials = ((): string => {
    const label = user?.name?.displayName ?? getNormalizedUserHandle(user);
    if (label) {
      const parts = label.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
      }
      return label.slice(0, 2).toUpperCase();
    }
    return 'U';
  })();

  // Members are fetched only for non-personal accounts with permission to read.
  const canManage = currentAccount ? canManageMembers(currentAccount) : false;
  const canTransfer = currentAccount ? canTransferOwnership(currentAccount) : false;
  const membersQuery = useAccountMembers(accountId, !!currentAccount && !isPersonal);
  const members = membersQuery.data ?? [];
  const activeMembers = members.filter((m) => m.status === 'active');
  const pendingInvites = members.filter((m) => m.status === 'invited');
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

  // General form — seeded from the current account via lazy initializers so the
  // inputs stay editable without an effect resetting them on every render. The
  // org/project display name is carried in `name.displayName` (set server-side
  // from the structured name); editing it writes back through `name.first`.
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
  }, [currentAccount?.accountId, currentAccount?.account.bio, currentAccount?.account.avatar, currentAccount?.account.name?.displayName]);

  // Invite dialog state
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteIdentifier, setInviteIdentifier] = useState('');
  const [inviteRole, setInviteRole] = useState<AssignableAccountRole>('editor');
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Member action state
  const [memberToPromote, setMemberToPromote] = useState<AccountMember | null>(null);

  // Delete dialog state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  if (!currentAccount || !accountId) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  const canEdit = canEditAccount(currentAccount);
  const canDelete = canArchiveAccount(currentAccount) && !isPersonal;

  const handleSave = async () => {
    const trimmed = name.trim();
    // Personal accounts cannot be renamed — never send a name change for them.
    if (!isPersonal && !trimmed) {
      toast.error('Account name is required');
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
      toast.success('Account updated');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update account'));
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
      toast.success(safeUrl ? 'Account avatar updated' : 'Account avatar removed');
    } catch (error) {
      // Revert the local preview to the persisted value on failure.
      setAvatar(currentAccount.account.avatar ?? '');
      toast.error(getErrorMessage(error, 'Failed to update account avatar'));
    }
  };

  const handleInviteDialogChange = (open: boolean) => {
    setShowInviteDialog(open);
    if (!open) {
      setInviteIdentifier('');
      setInviteRole('editor');
      setInviteError(null);
    }
  };

  const handleInvite = async () => {
    const usernameOrEmail = inviteIdentifier.trim();
    if (!usernameOrEmail) {
      setInviteError('Enter a username or email to invite');
      return;
    }
    setInviteError(null);

    try {
      await inviteMemberMutation.mutateAsync({
        accountId,
        usernameOrEmail,
        role: inviteRole,
      });
      toast.success('Invitation sent');
      setShowInviteDialog(false);
      setInviteIdentifier('');
      setInviteRole('editor');
    } catch (error) {
      if (isUserNotFoundError(error)) {
        setInviteError(USER_NOT_FOUND_MESSAGE);
        toast.error(USER_NOT_FOUND_MESSAGE);
        return;
      }
      toast.error(getErrorMessage(error, 'Failed to send invitation'));
    }
  };

  const handleRemoveMember = async (member: AccountMember) => {
    try {
      await removeMemberMutation.mutateAsync({ accountId, memberId: member._id });
      toast.success('Member removed');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to remove member'));
    }
  };

  const handleRoleChange = async (member: AccountMember, role: AssignableAccountRole) => {
    if (role === member.role) {
      return;
    }
    try {
      await updateMemberMutation.mutateAsync({ accountId, memberId: member._id, role });
      toast.success('Role updated');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update role'));
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
      toast.success('Ownership transferred');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to transfer ownership'));
    }
  };

  // Invitations are members with `status: 'invited'`; cancelling one is the
  // same operation as removing a member.
  const handleCancelInvite = async (invite: AccountMember) => {
    try {
      await removeMemberMutation.mutateAsync({ accountId, memberId: invite._id });
      toast.success('Invitation cancelled');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to cancel invitation'));
    }
  };

  const handleDelete = async () => {
    if (deleteConfirmation !== accountLabel) {
      toast.error('Please type the account name to confirm');
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
      toast.success('Account archived');
      setShowDeleteDialog(false);
      setDeleteConfirmation('');
      void navigate({ to: '/dashboard' });
    } catch (error) {
      // The API returns 409 when the account still owns applications.
      toast.error(
        getErrorMessage(error, 'Failed to archive account. Move or delete its apps first.')
      );
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <ScrollArea className="flex-1 bg-background">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <Link
          to="/dashboard"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
          Back to dashboard
        </Link>
        <div className="flex items-center gap-3">
          <div className="flex aspect-square size-10 items-center justify-center overflow-hidden rounded-lg bg-primary text-primary-foreground">
            {accountUser?.avatar ? (
              <img src={accountUser.avatar} alt={accountLabel} className="size-full object-cover" />
            ) : (
              <HugeiconsIcon icon={UserMultiple02Icon} size={20} />
            )}
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Account settings</h1>
            <p className="text-sm text-muted-foreground">{accountLabel}</p>
          </div>
        </div>
      </div>

      {/* General Settings */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground mb-4">General</h2>
        <div className="space-y-4 max-w-md">
          <div className="space-y-2">
            <Label>Avatar</Label>
            {isPersonal ? (
              <div className="flex items-center gap-3">
                <Avatar className="size-14 rounded-lg">
                  <AvatarImage src={userAvatarUrl} alt={accountLabel} />
                  <AvatarFallback className="rounded-lg text-base">{userInitials}</AvatarFallback>
                </Avatar>
                <p className="text-xs text-muted-foreground">
                  Your personal account uses your account avatar.{' '}
                  <a
                    href={config.accountsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    Managed in your Oxy account
                  </a>
                </p>
              </div>
            ) : (
              <ImageUploadField
                oxyServices={oxyServices}
                value={avatar}
                onChange={handleAvatarChange}
                disabled={!canEdit}
                label="Account avatar"
                onError={(message) => toast.error(message)}
                fallback={
                  <HugeiconsIcon icon={UserMultiple02Icon} size={24} className="text-muted-foreground" />
                }
              />
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">Account name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit || isPersonal}
              maxLength={50}
            />
            {isPersonal && (
              <p className="text-xs text-muted-foreground">
                Personal account name cannot be changed
              </p>
            )}
          </div>
          {!isPersonal && accountUser?.username && (
            <div className="space-y-2">
              <Label>Handle</Label>
              <p className="text-sm font-mono text-muted-foreground">@{accountUser.username}</p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="bio">Description</Label>
            <Textarea
              id="bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              disabled={!canEdit}
              placeholder="A brief description of this account"
              rows={3}
            />
          </div>
          {canEdit && !isPersonal && (
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save changes'}
            </Button>
          )}
        </div>
      </div>

      {/* Members */}
      {!isPersonal && (
        <div className="px-6 py-6 border-b border-border">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Members</h2>
            {canManage && (
              <Button size="sm" onClick={() => setShowInviteDialog(true)}>
                <HugeiconsIcon icon={Add01Icon} size={14} className="mr-1.5" />
                Invite
              </Button>
            )}
          </div>

          {/* Members List */}
          {membersQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton.Box key={i} width="100%" height={56} borderRadius={14} />
              ))}
            </div>
          ) : activeMembers.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <div className="space-y-2">
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
                const canRemoveThisMember =
                  canManage && isEditableHere && !isOwner && !isLastOwner;
                const canTransferToThis = canTransfer && isEditableHere && !isOwner;

                return (
                  <div
                    key={member._id}
                    className="flex items-center justify-between py-3 px-4 rounded-lg border"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar className="size-8">
                        <AvatarFallback>
                          {member.memberUserId[0]?.toUpperCase() ?? '?'}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="text-sm font-mono truncate" title={member.memberUserId}>
                          {shortUserId(member.memberUserId)}
                        </p>
                        <p className="text-xs text-muted-foreground">{roleLabels[member.role]}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {!isEditableHere ? (
                        <Badge variant="outline" title="Granted on a parent account">
                          Inherited
                        </Badge>
                      ) : null}
                      {isOwner ? (
                        <Badge variant="secondary" className="gap-1">
                          <HugeiconsIcon icon={CrownIcon} size={12} />
                          Owner
                        </Badge>
                      ) : canEditThisRole ? (
                        <Select
                          value={member.role}
                          onValueChange={(value) =>
                            handleRoleChange(member, value as AssignableAccountRole)
                          }
                        >
                          <SelectTrigger className="w-32 h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ASSIGNABLE_ROLES.map((role) => (
                              <SelectItem key={role} value={role}>
                                {roleLabels[role]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="outline">{roleLabels[member.role]}</Badge>
                      )}
                      {canTransferToThis && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setMemberToPromote(member)}
                          aria-label="Transfer ownership"
                          title="Transfer ownership"
                        >
                          <HugeiconsIcon icon={ArrowDataTransferHorizontalIcon} size={14} />
                        </Button>
                      )}
                      {canRemoveThisMember && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          onClick={() => handleRemoveMember(member)}
                          aria-label="Remove member"
                        >
                          <HugeiconsIcon icon={Cancel01Icon} size={14} />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pending Invites */}
          {pendingInvites.length > 0 && (
            <>
              <Separator className="my-4" />
              <h3 className="text-sm font-medium text-muted-foreground mb-3">Pending Invites</h3>
              <div className="space-y-2">
                {pendingInvites.map((invite) => (
                  <div
                    key={invite._id}
                    className="flex items-center justify-between py-3 px-4 rounded-lg border border-dashed"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex items-center justify-center size-8 rounded-full bg-muted shrink-0">
                        <HugeiconsIcon
                          icon={Mail01Icon}
                          size={14}
                          className="text-muted-foreground"
                        />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-mono truncate" title={invite.memberUserId}>
                          {shortUserId(invite.memberUserId)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Invited as {roleLabels[invite.role]}
                          {invite.createdAt
                            ? ` • ${new Date(invite.createdAt).toLocaleDateString()}`
                            : ''}
                        </p>
                      </div>
                    </div>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleCancelInvite(invite)}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Billing — account billing isn't a backend concept here; the dedicated
          Billing page covers it. */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground mb-4">Billing</h2>
        <div className="flex items-center justify-between p-4 rounded-lg border">
          <div>
            <p className="text-sm font-medium">Billing &amp; usage</p>
            <p className="text-xs text-muted-foreground">
              Manage your plan, credits, and invoices.
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/billing">Manage billing</Link>
          </Button>
        </div>
      </div>

      {/* Danger Zone */}
      {canDelete && (
        <div className="px-6 py-6">
          <h2 className="text-sm font-semibold text-destructive mb-4">Danger Zone</h2>
          <div className="p-4 rounded-lg border border-destructive/30 bg-destructive/5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Archive account</p>
                <p className="text-xs text-muted-foreground">
                  This archives the account. Move or delete its apps first.
                </p>
              </div>
              <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)}>
                <HugeiconsIcon icon={Delete02Icon} size={14} className="mr-1.5" />
                Archive
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Invite Dialog */}
      <Dialog open={showInviteDialog} onOpenChange={handleInviteDialogChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite member</DialogTitle>
            <DialogDescription>
              Add a member by their username or email and choose their role.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="invite-identifier">Username or email</Label>
              <Input
                id="invite-identifier"
                value={inviteIdentifier}
                onChange={(e) => {
                  setInviteIdentifier(e.target.value);
                  if (inviteError) {
                    setInviteError(null);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleInvite();
                  }
                }}
                placeholder="alice or alice@example.com"
                aria-invalid={inviteError ? true : undefined}
                aria-describedby={inviteError ? 'invite-identifier-error' : undefined}
              />
              {inviteError && (
                <p id="invite-identifier-error" className="text-sm text-destructive">
                  {inviteError}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                value={inviteRole}
                onValueChange={(v) => setInviteRole(v as AssignableAccountRole)}
              >
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      <div className="flex flex-col">
                        <span className="font-medium">{roleLabels[role]}</span>
                        <span className="text-xs text-muted-foreground">
                          {roleDescriptions[role]}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleInviteDialogChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleInvite}
              disabled={inviteMemberMutation.isPending || !inviteIdentifier.trim()}
            >
              {inviteMemberMutation.isPending ? 'Sending...' : 'Send invite'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transfer Ownership Confirmation */}
      <AlertDialog
        open={!!memberToPromote}
        onOpenChange={(open) => !open && setMemberToPromote(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transfer ownership</AlertDialogTitle>
            <AlertDialogDescription>
              Transfer ownership of this account to this member? You will be demoted to admin. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleTransfer}
              disabled={transferOwnershipMutation.isPending}
            >
              {transferOwnershipMutation.isPending ? 'Transferring...' : 'Transfer ownership'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive account</AlertDialogTitle>
            <AlertDialogDescription>
              This archives the account "{accountLabel}". The account must have no apps before it
              can be archived.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label htmlFor="delete-confirm" className="text-sm">
              Type <span className="font-mono font-semibold">{accountLabel}</span> to confirm
            </Label>
            <Input
              id="delete-confirm"
              value={deleteConfirmation}
              onChange={(e) => setDeleteConfirmation(e.target.value)}
              className="mt-2"
              placeholder={accountLabel}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteConfirmation('')}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteConfirmation !== accountLabel || isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? 'Archiving...' : 'Archive account'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  );
}
