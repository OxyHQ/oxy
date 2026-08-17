import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import {
  View,
  ActivityIndicator,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@oxyhq/bloom/toast';
import { surfaces } from '@oxyhq/bloom/surfaces';
import { useTheme } from '@oxyhq/bloom/theme';
import { Text } from '@oxyhq/bloom/typography';
import { Button } from '@oxyhq/bloom/button';
import { TextField, TextFieldInput } from '@oxyhq/bloom/text-field';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { DISPLAY_NAME_INVALID_MESSAGE, getNormalizedUserHandle, isValidDisplayName, MAX_DISPLAY_NAME_LENGTH, type UpdateAccountInput } from '@oxyhq/core';
import type { BaseScreenProps } from '../types/navigation';
import { SettingsIcon } from '../components/SettingsIcon';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import {
  clearedFieldsFromAccountUpdate,
  upsertCachedUser,
} from '../hooks/queries/userCache';

const DISPLAY_NAME_MAX = MAX_DISPLAY_NAME_LENGTH;
const BIO_MAX = 160;

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * Per-account settings: edit the account's profile, jump to member management,
 * and archive the account (danger zone). Receives the target `accountId` via
 * navigation props. Self-surface for the caller's own personal account lives in
 * {@link ManageAccountScreen}; this screen manages a non-personal account in the
 * graph.
 */
const AccountSettingsScreen: React.FC<BaseScreenProps> = ({ onClose, goBack, navigate, accountId }) => {
  const bloomTheme = useTheme();
  const colors = bloomTheme.colors;
  const { t } = useI18n();

  const { oxyServices, canUsePrivateApi, user, accounts, switchToAccount } = useOxy();
  const queryClient = useQueryClient();

  const id = typeof accountId === 'string' ? accountId : '';

  const accountQuery = useQuery({
    queryKey: ['accounts', 'detail', id],
    queryFn: () => oxyServices.getAccount(id),
    enabled: canUsePrivateApi && id.length > 0,
  });

  const node = accountQuery.data ?? null;
  const permissions = node?.callerMembership?.permissions ?? [];
  const isImplicitOwner = node ? node.relationship !== 'member' : false;
  const can = useCallback(
    (permission: string): boolean => isImplicitOwner || permissions.includes(permission),
    [isImplicitOwner, permissions],
  );
  const canUpdate = can('account:update');
  const canViewMembers = can('members:read');
  const canArchive = can('account:delete');

  // Editable fields, seeded lazily from the loaded account once.
  const [seeded, setSeeded] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [displayNameError, setDisplayNameError] = useState('');
  const [bio, setBio] = useState('');

  // Seed the form from the account during render (no useEffect): the first time
  // the query resolves we capture its values into local edit state.
  if (node && !seeded) {
    setDisplayName(
      node.account?.name?.displayName ?? getNormalizedUserHandle(node.account) ?? '',
    );
    setBio(node.account?.bio ?? '');
    setSeeded(true);
  }

  const updateMutation = useMutation({
    mutationKey: ['accounts', 'update', id],
    mutationFn: (input: UpdateAccountInput) => oxyServices.updateAccount(id, input),
    onSuccess: (updatedNode, input) => {
      const cleared = clearedFieldsFromAccountUpdate(input);
      upsertCachedUser(queryClient, updatedNode.account, user?.id, {
        cleared: cleared.length > 0 ? cleared : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ['accounts', 'detail', id] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success(t('accounts.settings.toasts.saved') || 'Account updated');
    },
    onError: (error) => {
      toast.error(errorMessage(error, t('accounts.settings.toasts.saveFailed') || 'Failed to update account'));
    },
  });

  const archiveMutation = useMutation({
    mutationKey: ['accounts', 'archive', id],
    mutationFn: () => oxyServices.archiveAccount(id),
    onSuccess: async () => {
      // If we archived the account we're currently signed in AS, switch back to
      // the personal account so the app isn't left as an archived identity.
      if (user?.id === id) {
        const personal = accounts.find((node) => node.relationship === 'self');
        if (personal) {
          await switchToAccount(personal.accountId).catch(() => undefined);
        }
      }
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success(t('accounts.settings.toasts.archived') || 'Account archived');
      (onClose ?? goBack)?.();
    },
    onError: (error) => {
      toast.error(errorMessage(error, t('accounts.settings.toasts.archiveFailed') || 'Failed to archive account'));
    },
  });

  const handleArchive = useCallback(async () => {
    const confirmed = await surfaces.confirm({
      title: t('accounts.settings.archive.confirmTitle') || 'Archive account',
      description:
        t('accounts.settings.archive.confirmDescription')
        || 'Archive this account? It will be deactivated and its members will lose access.',
      confirmLabel: t('accounts.settings.archive.title') || 'Archive account',
      cancelLabel: t('common.cancel') || 'Cancel',
      destructive: true,
    });
    if (confirmed) archiveMutation.mutate();
  }, [archiveMutation, t]);

  const handleDisplayNameChange = useCallback((value: string) => {
    setDisplayName(value);
    const trimmed = value.trim();
    if (!trimmed) {
      setDisplayNameError('');
      return;
    }
    const nameParts = trimmed.split(/\s+/).filter(Boolean);
    const first = nameParts[0] || '';
    const last = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    const invalidPart = [first, last].find((part) => part && !isValidDisplayName(part));
    setDisplayNameError(
      invalidPart
        ? (t('accounts.settings.displayName.invalidChars') || DISPLAY_NAME_INVALID_MESSAGE)
        : '',
    );
  }, [t]);

  const handleSave = useCallback(() => {
    const trimmed = displayName.trim();
    if (!trimmed || displayNameError) return;
    // Managed accounts (org / project / bot / channel) have a title, not a
    // given-and-family name — persist the explicit displayName column.
    updateMutation.mutate({
      name: { displayName: trimmed },
      bio: bio.trim() ? bio.trim() : null,
    });
  }, [displayName, displayNameError, bio, updateMutation]);

  const title = t('accounts.settings.title') || 'Account settings';

  const accountHandle = useMemo(() => {
    const username = node?.account?.username;
    return username ? `@${username}` : '';
  }, [node?.account?.username]);

  // The nav large title is the account's handle once loaded (falls back to the
  // generic screen title before the account resolves).
  useSurfaceHeader({
    title: accountHandle || title,
    subtitle: t('accounts.settings.subtitle') || 'Manage this account’s profile, members, and access.',
  });

  if (!id) {
    return (
      <>
        <View className="items-center justify-center px-screen-margin py-space-40">
          <Text className="text-body font-body text-text-secondary text-center">
            {t('accounts.settings.errors.missingAccount') || 'No account selected.'}
          </Text>
        </View>
      </>
    );
  }

  return (
    <>

      <View className="px-screen-margin pt-space-24 pb-space-32 gap-space-24">
          {accountQuery.isLoading ? (
            <View className="items-center py-space-32">
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <>
              {/* Profile edit */}
              {canUpdate ? (
                <View className="gap-space-16 p-space-16 rounded-radius-20 bg-fill">
                  <View className="gap-space-4">
                    <TextField isInvalid={Boolean(displayNameError)}>
                      <TextFieldInput
                        floatingLabel
                        label={t('accounts.settings.displayName.label') || 'Display name'}
                        value={displayName}
                        onChangeText={handleDisplayNameChange}
                        isInvalid={Boolean(displayNameError)}
                        maxLength={DISPLAY_NAME_MAX}
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
                        label={t('accounts.settings.bio.label') || 'Bio (optional)'}
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
                  <Button
                    variant="primary"
                    onPress={handleSave}
                    disabled={updateMutation.isPending || !displayName.trim() || Boolean(displayNameError)}
                    loading={updateMutation.isPending}
                    accessibilityLabel={t('accounts.settings.save') || 'Save changes'}
                    className="w-full"
                  >
                    {t('accounts.settings.save') || 'Save changes'}
                  </Button>
                </View>
              ) : null}

              {/* Members entry */}
              {canViewMembers ? (
                <SettingsListGroup title={t('accounts.settings.sections.access') || 'Access'}>
                  <SettingsListItem
                    icon={<SettingsIcon name="account-multiple" color={colors.info} />}
                    title={t('accounts.members.title') || 'Members'}
                    description={t('accounts.settings.members.subtitle') || 'Invite people and manage roles'}
                    onPress={() => navigate?.('AccountMembers', { accountId: id })}
                  />
                </SettingsListGroup>
              ) : null}

              {/* Danger zone */}
              {canArchive ? (
                <SettingsListGroup title={t('accounts.settings.sections.dangerZone') || 'Danger zone'}>
                  <SettingsListItem
                    icon={<SettingsIcon name="archive-arrow-down" color={colors.error} />}
                    title={t('accounts.settings.archive.title') || 'Archive account'}
                    description={t('accounts.settings.archive.subtitle') || 'Deactivate this account'}
                    onPress={handleArchive}
                  />
                </SettingsListGroup>
              ) : null}
            </>
          )}
      </View>
    </>
  );
};

export default AccountSettingsScreen;
