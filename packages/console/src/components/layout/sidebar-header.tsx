import * as React from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { Link } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  ArrowDown01Icon,
  Settings01Icon,
  Tick02Icon,
  UserMultiple02Icon,
} from '@hugeicons/core-free-icons';
import { useAuth } from '@oxyhq/services';
import { toast } from 'sonner';
import type {AccountKind, AccountNode, AccountRole} from '@/hooks/use-account';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  
  
  
  useAccount
} from '@/hooks/use-account';

const roleLabels: Record<AccountRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  developer: 'Developer',
  billing: 'Billing',
  viewer: 'Viewer',
};

const kindSubtitles: Record<AccountKind, string> = {
  personal: 'Developer Portal',
  organization: 'Organization',
  project: 'Project',
  bot: 'Bot',
};

/** Canonical display label: the account's `name.displayName`, else its handle. */
function accountLabel(node: AccountNode): string {
  return node.account.name?.displayName ?? node.account.username ?? 'Account';
}

/** First-letter initials for the avatar fallback. */
function accountInitials(node: AccountNode): string {
  return accountLabel(node).charAt(0).toUpperCase() || 'A';
}

/** The role badge to show for an account row, or null for the caller's own. */
function accountRoleLabel(node: AccountNode): string | null {
  if (node.relationship === 'self') {
    return null;
  }
  const role = node.callerMembership?.role;
  if (role) {
    return roleLabels[role];
  }
  return node.relationship === 'owner' ? 'Owner' : null;
}

export function SidebarHeaderBrand() {
  const { isMobile } = useSidebar();
  const { oxyServices } = useAuth();
  const { accounts, currentAccount, setCurrentAccount, createAccount, isLoading } = useAccount();

  // Resolve an account's avatar URL. Uploaded avatars are full public URLs;
  // file-id avatars (e.g. the user's own) resolve through the CDN helper.
  const resolveAvatarUrl = React.useCallback(
    (node: AccountNode): string | undefined => {
      const avatar = node.account.avatar;
      if (!avatar) return undefined;
      if (avatar.startsWith('http')) return avatar;
      return oxyServices.getFileDownloadUrl(avatar, 'thumb');
    },
    [oxyServices]
  );

  const [showCreateDialog, setShowCreateDialog] = React.useState(false);
  const [newAccountName, setNewAccountName] = React.useState('');
  const [newAccountHandle, setNewAccountHandle] = React.useState('');
  const [isCreating, setIsCreating] = React.useState(false);

  // Build a relationship-grouped, two-level tree from the flat account list. A
  // node is top-level when its parent is not in the accessible set; its direct
  // children nest one level beneath it. "Your accounts" holds `self`/`owner`
  // roots; "Shared with you" holds accounts shared via membership.
  const { yourAccounts, sharedAccounts, childrenOf } = React.useMemo(() => {
    const present = new Set(accounts.map((a) => a.accountId));
    const isTopLevel = (a: AccountNode) =>
      !a.parentAccountId || !present.has(a.parentAccountId);
    const topLevel = accounts.filter(isTopLevel);
    return {
      yourAccounts: topLevel.filter(
        (a) => a.relationship === 'self' || a.relationship === 'owner'
      ),
      sharedAccounts: topLevel.filter((a) => a.relationship === 'member'),
      childrenOf: (accountId: string) =>
        accounts.filter((a) => a.parentAccountId === accountId),
    };
  }, [accounts]);

  const handleCreateAccount = async () => {
    const name = newAccountName.trim();
    const handle = newAccountHandle.trim();
    if (!name) {
      toast.error('Please enter an account name');
      return;
    }
    if (!handle) {
      toast.error('Please enter a handle');
      return;
    }

    setIsCreating(true);
    try {
      await createAccount({
        kind: 'organization',
        username: handle,
        name: { first: name },
      });
      toast.success(`Account "${name}" created`);
      setShowCreateDialog(false);
      setNewAccountName('');
      setNewAccountHandle('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create account');
    } finally {
      setIsCreating(false);
    }
  };

  const handleSelectAccount = (account: AccountNode) => {
    setCurrentAccount(account);
    toast.success(`Switched to ${accountLabel(account)}`);
  };

  if (isLoading || !currentAccount) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg">
            <Skeleton.Box width={32} height={32} borderRadius={14} />
            <div className="grid flex-1 gap-1">
              <Skeleton.Box width={96} height={16} />
              <Skeleton.Box width={64} height={12} />
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const currentAvatarUrl = resolveAvatarUrl(currentAccount);

  // A single selectable account row, optionally indented as a child node.
  const renderAccountRow = (node: AccountNode, indented: boolean) => {
    const avatarUrl = resolveAvatarUrl(node);
    const roleLabel = accountRoleLabel(node);
    const isCurrent = currentAccount.accountId === node.accountId;
    return (
      <DropdownMenuItem
        key={node.accountId}
        className={`gap-2 p-2${indented ? ' pl-7' : ''}`}
        onClick={() => handleSelectAccount(node)}
      >
        {node.kind === 'personal' ? (
          <Avatar className="size-6 rounded-md">
            <AvatarImage src={avatarUrl} alt={accountLabel(node)} />
            <AvatarFallback className="rounded-md text-xs">{accountInitials(node)}</AvatarFallback>
          </Avatar>
        ) : (
          <div className="flex size-6 items-center justify-center overflow-hidden rounded-md border bg-primary text-primary-foreground">
            {avatarUrl ? (
              <img src={avatarUrl} alt={accountLabel(node)} className="size-full object-cover" />
            ) : (
              <HugeiconsIcon icon={UserMultiple02Icon} size={14} />
            )}
          </div>
        )}
        <span className="flex-1 truncate">{accountLabel(node)}</span>
        {roleLabel && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {roleLabel}
          </Badge>
        )}
        {isCurrent && <HugeiconsIcon icon={Tick02Icon} size={14} className="text-primary" />}
      </DropdownMenuItem>
    );
  };

  // Render a top-level account followed by its direct children (one level).
  const renderAccountTree = (node: AccountNode) => (
    <React.Fragment key={node.accountId}>
      {renderAccountRow(node, false)}
      {childrenOf(node.accountId).map((child) => renderAccountRow(child, true))}
    </React.Fragment>
  );

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                {currentAccount.kind === 'personal' ? (
                  <Avatar className="size-8 rounded-lg">
                    <AvatarImage src={currentAvatarUrl} alt={accountLabel(currentAccount)} />
                    <AvatarFallback className="rounded-lg">
                      {accountInitials(currentAccount)}
                    </AvatarFallback>
                  </Avatar>
                ) : (
                  <div className="flex aspect-square size-8 items-center justify-center overflow-hidden rounded-lg bg-primary text-primary-foreground">
                    {currentAvatarUrl ? (
                      <img
                        src={currentAvatarUrl}
                        alt={accountLabel(currentAccount)}
                        className="size-full object-cover"
                      />
                    ) : (
                      <HugeiconsIcon icon={UserMultiple02Icon} size={18} />
                    )}
                  </div>
                )}
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">{accountLabel(currentAccount)}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {kindSubtitles[currentAccount.kind]}
                  </span>
                </div>
                <HugeiconsIcon icon={ArrowDown01Icon} className="ml-auto" size={16} />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
              align="start"
              side={isMobile ? 'bottom' : 'right'}
              sideOffset={4}
            >
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                Your accounts
              </DropdownMenuLabel>
              {yourAccounts.map((node) => renderAccountTree(node))}

              {sharedAccounts.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-muted-foreground text-xs">
                    Shared with you
                  </DropdownMenuLabel>
                  {sharedAccounts.map((node) => renderAccountTree(node))}
                </>
              )}

              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2 p-2" asChild>
                <Link to="/settings/account">
                  <HugeiconsIcon icon={Settings01Icon} size={14} className="text-muted-foreground" />
                  <span>Account settings</span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2 p-2" onClick={() => setShowCreateDialog(true)}>
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <HugeiconsIcon icon={Add01Icon} size={14} />
                </div>
                <span className="text-muted-foreground font-medium">Create account</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create account</DialogTitle>
            <DialogDescription>
              Create a new organization account to group apps and members. Members can be added
              later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="account-name" className="text-sm">
                Account name *
              </Label>
              <Input
                id="account-name"
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                placeholder="My Team"
                maxLength={50}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="account-handle" className="text-sm">
                Handle *
              </Label>
              <Input
                id="account-handle"
                value={newAccountHandle}
                onChange={(e) => setNewAccountHandle(e.target.value)}
                placeholder="my-team"
                maxLength={50}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateAccount}
              disabled={isCreating || !newAccountName.trim() || !newAccountHandle.trim()}
            >
              {isCreating ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
