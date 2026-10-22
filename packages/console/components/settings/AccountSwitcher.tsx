import { Avatar } from '@oxy.so/bloom/avatar';
import { Dialog } from '@oxy.so/bloom/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiArrowDownSLine } from '@oxy.so/bloom/icons/RiArrowDownSLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useTheme } from '@oxy.so/bloom/theme';
import { useAuth } from '@oxy.so/services/ui/client';
import { type Href, useRouter } from 'expo-router';
import { Fragment, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { StatusBadge } from '@/components/account-pages/StatusBadge';
import { type AccountNode, accountLabel, useAccount } from '@/hooks/use-account';
import { useTranslation } from '@/lib/i18n';
import { accountInitials, resolveStoredImageUrl, useAccountLabels } from './account-labels';
import { buildWorkspaceTree } from './workspace-tree';

/**
 * Workspace (account) switcher: the account graph the caller can become, grouped
 * as "yours" and "shared with you", two levels deep, with Create workspace and a
 * link to the workspace settings.
 *
 * Not mounted by this module: `ConsoleShell` renders it where it wants it (the
 * sidebar header). `compact` drops the text and keeps the avatar for a collapsed
 * sidebar.
 */
export function AccountSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const labels = useAccountLabels();
  const router = useRouter();
  const theme = useTheme();
  const { oxyServices } = useAuth();
  const { accounts, currentAccount, setCurrentAccount, createAccount, isLoading } = useAccount();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountHandle, setNewAccountHandle] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const { yourAccounts, sharedAccounts, childrenOf } = useMemo(
    () => buildWorkspaceTree(accounts),
    [accounts],
  );

  const avatarUri = (node: AccountNode) => resolveStoredImageUrl(oxyServices, node.account.avatar);

  const handleCreateAccount = async () => {
    const name = newAccountName.trim();
    const handle = newAccountHandle.trim();
    if (!name) {
      toast.error(t('settingsPage.switcher.nameRequired'));
      return;
    }
    if (!handle) {
      toast.error(t('settingsPage.switcher.handleRequired'));
      return;
    }

    setIsCreating(true);
    try {
      await createAccount({ kind: 'organization', username: handle, name: { first: name } });
      toast.success(t('settingsPage.switcher.created', { name }));
      setShowCreateDialog(false);
      setNewAccountName('');
      setNewAccountHandle('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settingsPage.switcher.createFailed'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleSelectAccount = async (account: AccountNode) => {
    if (account.accountId === currentAccount?.accountId) {
      return;
    }
    try {
      await setCurrentAccount(account);
      toast.success(t('settingsPage.switcher.switched', { name: accountLabel(account) }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settingsPage.switcher.switchFailed'));
    }
  };

  if (isLoading || !currentAccount) {
    return (
      <View className="flex-row items-center gap-2 p-2">
        <Skeleton.Box width={32} height={32} borderRadius={14} />
        {compact ? null : (
          <View className="gap-1">
            <Skeleton.Box width={96} height={16} />
            <Skeleton.Box width={64} height={12} />
          </View>
        )}
      </View>
    );
  }

  const renderAccountRow = (node: AccountNode, indented: boolean) => {
    const label = accountLabel(node);
    const roleLabel = labels.accountRole(node);
    const isCurrent = currentAccount.accountId === node.accountId;
    return (
      <DropdownMenuItem
        key={node.accountId}
        onPress={() => void handleSelectAccount(node)}
        leading={
          <View className={indented ? 'pl-4' : ''}>
            <Avatar size={24} uri={avatarUri(node)} initials={accountInitials(label)} alt={label} />
          </View>
        }
        trailing={
          <View className="flex-row items-center gap-2">
            {roleLabel ? <StatusBadge variant="outline" label={roleLabel} /> : null}
            {isCurrent ? <RiCheckLine size="sm" fill={theme.colors.primary} /> : null}
          </View>
        }
      >
        {label}
      </DropdownMenuItem>
    );
  };

  // A top-level account followed by its direct children (one level).
  const renderAccountTree = (node: AccountNode) => (
    <Fragment key={node.accountId}>
      {renderAccountRow(node, false)}
      {childrenOf(node.accountId).map((child) => renderAccountRow(child, true))}
    </Fragment>
  );

  const currentLabel = accountLabel(currentAccount);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger label={t('settingsPage.switcher.label')}>
          <View className="flex-row items-center gap-2 rounded-lg p-2">
            <Avatar
              size={32}
              uri={avatarUri(currentAccount)}
              initials={accountInitials(currentLabel)}
              alt={currentLabel}
            />
            {compact ? null : (
              <>
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
                    {currentLabel}
                  </Text>
                  <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                    {labels.kind(currentAccount.kind)}
                  </Text>
                </View>
                <RiArrowDownSLine size="sm" fill={theme.colors.textSecondary} />
              </>
            )}
          </View>
        </DropdownMenuTrigger>
        <DropdownMenuContent label={t('settingsPage.switcher.workspaces')} minWidth={224}>
          <DropdownMenuLabel>{t('settingsPage.switcher.workspaces')}</DropdownMenuLabel>
          {yourAccounts.map((node) => renderAccountTree(node))}

          {sharedAccounts.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t('settingsPage.switcher.shared')}</DropdownMenuLabel>
              {sharedAccounts.map((node) => renderAccountTree(node))}
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            leading={<RiSettings3Line size="sm" fill={theme.colors.textSecondary} />}
            onPress={() => router.navigate('/settings/account' as Href)}
          >
            {t('settingsPage.switcher.settings')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            leading={<RiAddLine size="sm" fill={theme.colors.textSecondary} />}
            onPress={() => setShowCreateDialog(true)}
          >
            {t('settingsPage.switcher.create')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        title={t('settingsPage.switcher.create')}
        description={t('settingsPage.switcher.createDescription')}
        actions={[
          { label: t('common.cancel'), color: 'cancel' },
          {
            label: isCreating ? t('settingsPage.switcher.creating') : t('common.create'),
            onPress: () => void handleCreateAccount(),
            disabled: isCreating || !newAccountName.trim() || !newAccountHandle.trim(),
            shouldCloseOnPress: false,
          },
        ]}
      >
        <View className="gap-4 py-2">
          <TextFieldInput
            label={t('settingsPage.switcher.accountName')}
            value={newAccountName}
            onChangeText={setNewAccountName}
            placeholder="My Team"
            maxLength={50}
          />
          <TextFieldInput
            label={t('settingsPage.switcher.handle')}
            value={newAccountHandle}
            onChangeText={setNewAccountHandle}
            placeholder="my-team"
            maxLength={50}
            autoCapitalize="none"
          />
        </View>
      </Dialog>
    </>
  );
}
