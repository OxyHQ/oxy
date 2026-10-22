import type React from 'react';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import {
  accountNameInvalidKey,
  accountNameInvalidMessage,
  accountNameMaxLength,
  getNormalizedUserHandle,
  isValidAccountName,
  kindAcceptsAccountCategories,
  type AccountCategoryId,
  type AccountNode,
  type UpdateAccountInput,
  type User,
} from '@oxy.so/core';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import { pickAvatarFile } from '../../hooks/useAvatarPicker';
import {
  clearedFieldsFromAccountUpdate,
  upsertCachedUser,
  type ClearableUserField,
} from '../../hooks/queries/userCache';
import type { BaseScreenProps } from '../../types/navigation';
import { OrganizationSettings } from '../organizations/OrganizationSettings';
import { SettingsIcon } from '../SettingsIcon';
import { AccountCategoriesSection, accountCategoriesEqual } from './AccountCategoriesSection';

const BIO_MAX = 160;
const AVATAR_SIZE = 64;

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * How archiving the account behaves, for an app whose ending of an account
 * means more than Oxy's archive.
 */
export interface AccountSettingsArchiveOptions {
  /** The danger-zone row's title, replacing "Archive account". */
  title?: string;
  /**
   * The row's subtitle. With a `title` of its own the row shows only this
   * (nothing when omitted), never Oxy's subtitle under the app's title.
   */
  description?: string;
  /** The danger-zone section's footer. */
  footer?: string;
  /**
   * Replaces the default confirmation. Resolve `false` to back out; a rejection
   * is reported as an archive failure and nothing is archived.
   */
  confirm?: (node: AccountNode) => Promise<boolean>;
  /**
   * Runs after the confirmation and BEFORE Oxy archives the account — for an
   * app's own data that has to go while the account still resolves. A
   * rejection stops the archive and is reported as an archive failure.
   */
  beforeArchive?: (node: AccountNode) => Promise<void>;
  /** After the archive, in place of closing the surface. */
  onArchived?: (node: AccountNode) => void;
  /** The success toast, replacing "Account archived". */
  successMessage?: string;
}

export interface AccountSettingsProps {
  accountId: string;
  /**
   * The app's own sections for this account, rendered after the account's
   * profile, categories and members, and before the danger zone.
   */
  extraSections?: ReactNode;
  /**
   * After each accepted profile write — name, bio, picture, categories — with
   * the account Oxy returned and the fields the write cleared. The SDK's user
   * cache already holds the change; this is for an app's own copies of the
   * identity (posts that embed it, for example).
   */
  onUpdated?: (account: User, change: { cleared: ClearableUserField[] }) => void;
  archive?: AccountSettingsArchiveOptions;
  /**
   * The host surface's navigation, for the SDK routes this opens (Members).
   * Omitted when the settings are embedded in an app's own page, and those
   * routes open as a sheet.
   */
  navigate?: BaseScreenProps['navigate'];
  /** Called after an archive when `archive.onArchived` is not given. */
  onClose?: () => void;
}

/**
 * The account-graph node {@link AccountSettings} edits — seeded from the
 * session's account list, then read fresh. `node` is `null` until it resolves.
 */
export function useAccountSettingsNode(accountId: string) {
  const { oxyServices, canUsePrivateApi, user, accounts } = useOxy();
  const query = useQuery({
    queryKey: ['accounts', 'detail', accountId, user?.id, canUsePrivateApi],
    initialData: canUsePrivateApi
      ? accounts?.find((account) => account.accountId === accountId)
      : undefined,
    initialDataUpdatedAt: 0,
    queryFn: () => oxyServices.accounts.get(accountId),
    enabled: canUsePrivateApi && accountId.length > 0,
  });
  return { query, node: canUsePrivateApi && query.isSuccess ? query.data : null };
}

/**
 * A non-personal account's settings: its picture, name, bio and categories,
 * its members, and archiving it. The one editor for every member-operated
 * account — the `AccountSettings` surface renders it, and an app embeds it in
 * its own page (`@oxy.so/services/screens`) with its own sections and archive
 * steps around it. Oxy decides what the caller may do from the membership it
 * resolved, so every section is shown only to a member who holds its right.
 */
export const AccountSettings: React.FC<AccountSettingsProps> = ({
  accountId,
  extraSections,
  onUpdated,
  archive,
  navigate,
  onClose,
}) => {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { oxyServices, user, accounts, switchToAccount, showBottomSheet } = useOxy();
  const queryClient = useQueryClient();
  const id = accountId;
  const { query: accountQuery, node } = useAccountSettingsNode(id);
  const account = node?.account;
  const permissions = node?.callerMembership?.permissions ?? [];
  const isImplicitOwner = node ? node.relationship !== 'member' : false;
  const can = useCallback(
    (permission: string): boolean => isImplicitOwner || permissions.includes(permission),
    [isImplicitOwner, permissions],
  );
  const canUpdate = can('account:update');
  const canViewMembers = can('members:read');
  const canArchive = can('account:delete');
  const hasCategories = kindAcceptsAccountCategories(node?.kind);

  // Editable fields, seeded once from the loaded account and NOT re-synced: while
  // the form is open it is the only writer, so a sync could only overwrite what
  // is being typed. The stored values are read on every render for the dirty
  // check, so a save settles the button without anything mirroring state.
  const [seeded, setSeeded] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [displayNameError, setDisplayNameError] = useState('');
  const [bio, setBio] = useState('');
  // Verbatim, including an id this build cannot name: dropping it on load would
  // delete it on the next save.
  const [categories, setCategories] = useState<AccountCategoryId[]>([]);

  const storedName = account?.name?.displayName ?? getNormalizedUserHandle(account) ?? '';
  const storedCategories = account?.accountCategories ?? [];
  if (node && !seeded) {
    setDisplayName(storedName);
    setBio(account?.bio ?? '');
    setCategories([...storedCategories]);
    setSeeded(true);
  }

  const updateMutation = useMutation({
    mutationKey: ['accounts', 'update', id],
    mutationFn: (input: UpdateAccountInput) => oxyServices.accounts.update(id, input),
    onSuccess: (updatedNode, input) => {
      const cleared = clearedFieldsFromAccountUpdate(input);
      upsertCachedUser(queryClient, updatedNode.account, user?.id, {
        cleared: cleared.length > 0 ? cleared : undefined,
      });
      onUpdated?.(updatedNode.account, { cleared });
      queryClient.invalidateQueries({ queryKey: ['accounts', 'detail', id] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success(t('accounts.settings.toasts.saved'));
    },
    onError: (error) => {
      toast.error(errorMessage(error, t('accounts.settings.toasts.saveFailed')));
    },
  });

  const archiveMutation = useMutation({
    mutationKey: ['accounts', 'archive', id],
    mutationFn: async (target: AccountNode) => {
      await archive?.beforeArchive?.(target);
      await oxyServices.accounts.archive(id);
      return target;
    },
    onSuccess: async (target) => {
      // If we archived the account we're currently signed in AS, switch back to
      // the personal account so the app isn't left as an archived identity.
      if (user?.id === id) {
        const personal = accounts.find((entry) => entry.relationship === 'self');
        if (personal) {
          await switchToAccount(personal.accountId).catch(() => undefined);
        }
      }
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success(archive?.successMessage ?? t('accounts.settings.toasts.archived'));
      if (archive?.onArchived) archive.onArchived(target);
      else onClose?.();
    },
    onError: (error) => {
      toast.error(errorMessage(error, t('accounts.settings.toasts.archiveFailed')));
    },
  });

  const handleArchive = useCallback(async () => {
    if (!node) return;
    let confirmed: boolean;
    try {
      confirmed = archive?.confirm
        ? await archive.confirm(node)
        : await surfaces.confirm({
            title: t('accounts.settings.archive.confirmTitle'),
            description: t('accounts.settings.archive.confirmDescription'),
            confirmLabel: t('accounts.settings.archive.title'),
            cancelLabel: t('common.cancel'),
            destructive: true,
          });
    } catch (error) {
      toast.error(errorMessage(error, t('accounts.settings.toasts.archiveFailed')));
      return;
    }
    if (confirmed) archiveMutation.mutate(node);
  }, [archive, archiveMutation, node, t]);

  const handleDisplayNameChange = useCallback(
    (value: string) => {
      setDisplayName(value);
      const trimmed = value.trim();
      if (!trimmed) {
        setDisplayNameError('');
        return;
      }
      const kind = node?.account.kind;
      setDisplayNameError(
        isValidAccountName(trimmed, kind)
          ? ''
          : t(`accounts.settings.displayName.${accountNameInvalidKey(kind)}`) ||
              accountNameInvalidMessage(kind),
      );
    },
    [node?.account.kind, t],
  );

  const trimmedName = displayName.trim();
  const trimmedBio = bio.trim();
  const categoriesChanged = hasCategories && !accountCategoriesEqual(categories, storedCategories);
  const profileChanged =
    trimmedName !== storedName.trim() ||
    trimmedBio !== (account?.bio ?? '').trim() ||
    categoriesChanged;
  // An empty display name is refused rather than sent: at Oxy an empty
  // `displayName` clears the explicit name, which a managed account (a title,
  // not a given-and-family name) has nothing to fall back from.
  const canSave = profileChanged && trimmedName.length > 0 && !displayNameError;

  const handleSave = useCallback(() => {
    if (!canSave) return;
    updateMutation.mutate({
      name: { displayName: trimmedName },
      // `null` is Oxy's clear; an empty string would store one.
      bio: trimmedBio ? trimmedBio : null,
      // Whole and IN ORDER — element 0 is the primary, and `[]` is the clear.
      ...(categoriesChanged ? { accountCategories: categories } : null),
    });
  }, [canSave, categories, categoriesChanged, trimmedBio, trimmedName, updateMutation]);

  // The picture is written on its own, as the personal profile's is: the shared
  // picker uploads the crop, and the account takes it (or `null`, its clear).
  const handleChangePicture = useCallback(async () => {
    try {
      const avatar = await pickAvatarFile(oxyServices, {
        avatar: account?.avatar,
        displayName: storedName,
      });
      if (avatar !== undefined) updateMutation.mutate({ avatar });
    } catch (error) {
      toast.error(errorMessage(error, t('accounts.settings.toasts.saveFailed')));
    }
  }, [account?.avatar, oxyServices, storedName, t, updateMutation]);

  const avatarUri = useMemo(
    () => (account?.avatar ? oxyServices.assets.publicUrl(account.avatar, 'thumb') : undefined),
    [account?.avatar, oxyServices],
  );

  const openMembers = useCallback(() => {
    if (navigate) navigate('AccountMembers', { accountId: id });
    else showBottomSheet?.({ screen: 'AccountMembers', props: { accountId: id } });
  }, [id, navigate, showBottomSheet]);

  if (!id) {
    return (
      <View className="items-center justify-center px-screen-margin py-space-40">
        <Text className="text-body font-body text-text-secondary text-center">
          {t('accounts.settings.errors.missingAccount')}
        </Text>
      </View>
    );
  }

  if (accountQuery.isLoading || !node) {
    return <View className="items-center py-space-32" />;
  }

  const busy = updateMutation.isPending;

  return (
    <View className="px-screen-margin pt-space-24 pb-space-32 gap-space-24">
      {canUpdate ? (
        <View className="gap-space-16 p-space-16 rounded-radius-20 bg-fill">
          <View className="flex-row items-center gap-space-16">
            <Avatar source={avatarUri} name={storedName} size={AVATAR_SIZE} />
            <Button
              appearance="subtle"
              size="sm"
              onPress={() => void handleChangePicture()}
              disabled={busy}
            >
              {t('accounts.settings.picture.change')}
            </Button>
          </View>
          <View className="gap-space-4">
            <TextField isInvalid={Boolean(displayNameError)}>
              <TextFieldInput
                floatingLabel
                label={t('accounts.settings.displayName.label')}
                value={displayName}
                onChangeText={handleDisplayNameChange}
                isInvalid={Boolean(displayNameError)}
                maxLength={accountNameMaxLength(node.account.kind)}
              />
            </TextField>
            {displayNameError ? (
              <Text className="text-caption font-caption text-negative px-space-4">
                {displayNameError}
              </Text>
            ) : null}
          </View>
          <View className="gap-space-4">
            <TextField>
              <TextFieldInput
                floatingLabel
                label={t('accounts.settings.bio.label')}
                value={bio}
                onChangeText={setBio}
                maxLength={BIO_MAX}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </TextField>
            <Text className="text-caption font-caption text-text-tertiary px-space-4 text-right">
              {bio.length}/{BIO_MAX}
            </Text>
          </View>
          {hasCategories ? (
            <AccountCategoriesSection value={categories} onChange={setCategories} disabled={busy} />
          ) : null}
          <Button
            appearance="solid"
            tone="accent"
            onPress={handleSave}
            disabled={busy || !canSave}
            loading={busy}
            accessibilityLabel={t('accounts.settings.save')}
            className="w-full"
          >
            {t('accounts.settings.save')}
          </Button>
        </View>
      ) : null}

      {node.account.kind === 'organization' ? (
        <OrganizationSettings key={id} accountId={id} canUpdate={canUpdate} />
      ) : null}

      {canViewMembers ? (
        <GroupedSection title={t('accounts.settings.sections.access')}>
          <GroupedSectionItem
            icon={<SettingsIcon name="account-multiple" color={colors.info} />}
            title={t('accounts.members.title')}
            description={t('accounts.settings.members.subtitle')}
            onPress={openMembers}
          />
        </GroupedSection>
      ) : null}

      {extraSections}

      {canArchive ? (
        <GroupedSection title={t('accounts.settings.sections.dangerZone')} footer={archive?.footer}>
          <GroupedSectionItem
            icon={<SettingsIcon name="archive-arrow-down" color={colors.error} />}
            title={archive?.title ?? t('accounts.settings.archive.title')}
            description={
              archive?.title ? archive.description : t('accounts.settings.archive.subtitle')
            }
            destructive
            disabled={archiveMutation.isPending}
            onPress={() => void handleArchive()}
          />
        </GroupedSection>
      ) : null}
    </View>
  );
};

export default AccountSettings;
