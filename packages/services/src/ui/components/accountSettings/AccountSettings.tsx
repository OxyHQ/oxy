import type React from 'react';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { skip, useAction, useRecord } from '@oxy.so/bloom-data';
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
import { accountNode, archiveAccount, updateAccount } from '../../data/account';
import { clearedFieldsFromAccountUpdate, type ClearableUserField } from '../../data/userRecord';
import type { BaseScreenProps } from '../../types/navigation';
import { OrganizationSettings } from '../organizations/OrganizationSettings';
import { SettingsIcon } from '../SettingsIcon';
import { AccountCategoriesSection, accountCategoriesEqual } from './AccountCategoriesSection';
import { useApiErrorToast } from '../../hooks/useApiErrorToast';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const BIO_MAX = 160;
const AVATAR_SIZE = 64;

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
  const { oxyServices, canUsePrivateApi, accounts } = useOxy();
  const view = useRecord(
    accountNode,
    ...(canUsePrivateApi && accountId.length > 0 ? ([oxyServices, accountId] as const) : [skip]),
  );
  // Until it is read, the node the session's account list holds.
  const seed = canUsePrivateApi
    ? accounts?.find((account) => account.accountId === accountId)
    : undefined;
  const node = canUsePrivateApi && view.status !== 'error' ? (view.value ?? seed ?? null) : null;
  return { view, node };
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
  const styles = useStyles();
  const { colors } = useTheme();
  const { t } = useI18n();
  const showApiError = useApiErrorToast();
  const { oxyServices, user, accounts, switchToAccount, showBottomSheet } = useOxy();
  const id = accountId;
  const { view: accountView, node } = useAccountSettingsNode(id);
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

  const update = useAction(updateAccount);
  const { run: runUpdate } = update;
  const save = useCallback(
    async (input: UpdateAccountInput) => {
      try {
        const updatedNode = await runUpdate(oxyServices, id, input);
        if (!updatedNode) return;
        onUpdated?.(updatedNode.account, { cleared: clearedFieldsFromAccountUpdate(input) });
        toast.success(t('accounts.settings.toasts.saved'));
      } catch (error) {
        showApiError(error, 'accounts.settings.toasts.saveFailed');
      }
    },
    [runUpdate, oxyServices, id, onUpdated, t, showApiError],
  );

  const archiving = useAction(archiveAccount);
  const { run: runArchive } = archiving;
  const archiveNode = useCallback(
    async (target: AccountNode) => {
      try {
        const beforeArchive = archive?.beforeArchive;
        await runArchive(oxyServices, id, beforeArchive ? () => beforeArchive(target) : undefined);
        // If we archived the account we're currently signed in AS, switch back to
        // the personal account so the app isn't left as an archived identity.
        if (user?.id === id) {
          const personal = accounts.find((entry) => entry.relationship === 'self');
          if (personal) {
            await switchToAccount(personal.accountId).catch(() => undefined);
          }
        }
        toast.success(archive?.successMessage ?? t('accounts.settings.toasts.archived'));
        if (archive?.onArchived) archive.onArchived(target);
        else onClose?.();
      } catch (error) {
        showApiError(error, 'accounts.settings.toasts.archiveFailed');
      }
    },
    [
      runArchive,
      oxyServices,
      id,
      archive,
      user?.id,
      accounts,
      switchToAccount,
      t,
      onClose,
      showApiError,
    ],
  );

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
      showApiError(error, 'accounts.settings.toasts.archiveFailed');
      return;
    }
    if (confirmed) void archiveNode(node);
  }, [archive, archiveNode, node, showApiError, t]);

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
    void save({
      name: { displayName: trimmedName },
      // `null` is Oxy's clear; an empty string would store one.
      bio: trimmedBio ? trimmedBio : null,
      // Whole and IN ORDER — element 0 is the primary, and `[]` is the clear.
      ...(categoriesChanged ? { accountCategories: categories } : null),
    });
  }, [canSave, categories, categoriesChanged, trimmedBio, trimmedName, save]);

  // The picture is written on its own, as the personal profile's is: the shared
  // picker uploads the crop, and the account takes it (or `null`, its clear).
  const handleChangePicture = useCallback(async () => {
    try {
      const avatar = await pickAvatarFile(oxyServices, {
        avatar: account?.avatar,
        displayName: storedName,
      });
      if (avatar !== undefined) await save({ avatar });
    } catch (error) {
      showApiError(error, 'accounts.settings.toasts.saveFailed');
    }
  }, [account?.avatar, oxyServices, showApiError, storedName, save]);

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
      <View style={styles.centered}>
        <Text style={styles.mutedText}>{t('accounts.settings.errors.missingAccount')}</Text>
      </View>
    );
  }

  if (accountView.isLoading || !node) {
    return <View style={styles.container} />;
  }

  const busy = update.isPending;

  return (
    <View style={styles.container2}>
      {canUpdate ? (
        <View style={styles.surface}>
          <View style={styles.row}>
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
          <View style={styles.stack}>
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
            {displayNameError ? <Text style={styles.text}>{displayNameError}</Text> : null}
          </View>
          <View style={styles.stack}>
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
            <Text style={styles.mutedText2}>
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
            style={styles.button}
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
            disabled={archiving.isPending}
            onPress={() => void handleArchive()}
          />
        </GroupedSection>
      ) : null}
    </View>
  );
};

export default AccountSettings;

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
  container: { alignItems: 'center', paddingVertical: 32 },
  container2: { gap: 24, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 32 },
  surface: { gap: 16, borderRadius: 20, backgroundColor: t.card, padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  stack: { gap: 4 },
  text: { paddingHorizontal: 4, fontSize: 11, lineHeight: 14, fontWeight: 400 },
  mutedText2: {
    paddingHorizontal: 4,
    textAlign: 'right',
    fontSize: 11,
    color: t.mutedForeground,
    lineHeight: 14,
    fontWeight: 400,
  },
  button: { width: '100%' },
}));
