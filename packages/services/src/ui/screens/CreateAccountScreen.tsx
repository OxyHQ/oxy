import type React from 'react';
import { useState, useCallback, useRef, useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { AccountKind, CreateAccountInput, OrganizationCategory } from '@oxyhq/core';
import { ORGANIZATION_CATEGORIES } from '@oxyhq/core';
import type { BaseScreenProps } from '../types/navigation';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useTheme } from '@oxyhq/bloom/theme';
import { Text } from '@oxyhq/bloom/typography';
import { Button } from '@oxyhq/bloom/button';
import { TextField, TextFieldInput } from '@oxyhq/bloom/text-field';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useOxy } from '../context/OxyContext';
import { toast } from '@oxyhq/bloom';

type UsernameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

/** Kind of account this screen can create. `personal` is a signup-minted root and is never created here. */
type CreatableAccountKind = Exclude<AccountKind, 'personal'>;

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,30}$/;
const DEBOUNCE_MS = 400;
const USERNAME_MAX = 30;
const DISPLAY_NAME_MAX = 50;
const BIO_MAX = 160;

interface KindOption {
  value: CreatableAccountKind;
  icon: React.ComponentProps<typeof Ionicons>['name'];
}

// The creatable account kinds, matching the API `createAccountSchema` enum.
// Order places the most common choice (a project / persona) first.
const KIND_OPTIONS: KindOption[] = [
  { value: 'project', icon: 'cube-outline' },
  { value: 'organization', icon: 'business-outline' },
  { value: 'bot', icon: 'hardware-chip-outline' },
];

const kindLabel = (
  t: (key: string, vars?: Record<string, string | number>) => string,
  kind: CreatableAccountKind,
): string => {
  switch (kind) {
    case 'organization':
      return t('accounts.kinds.organization.label') || 'Organization';
    case 'bot':
      return t('accounts.kinds.bot.label') || 'Bot';
    default:
      return t('accounts.kinds.project.label') || 'Project';
  }
};

const kindDescription = (
  t: (key: string, vars?: Record<string, string | number>) => string,
  kind: CreatableAccountKind,
): string => {
  switch (kind) {
    case 'organization':
      return t('accounts.kinds.organization.description') || 'A shared team account with members';
    case 'bot':
      return t('accounts.kinds.bot.description') || 'A programmatic account with service credentials';
    default:
      return t('accounts.kinds.project.description') || 'A separate account you control';
  }
};

const organizationCategoryLabel = (
  t: (key: string, vars?: Record<string, string | number>) => string,
  category: OrganizationCategory,
): string => {
  switch (category) {
    case 'agency':
      return t('accounts.organizationCategory.agency');
    case 'cooperative':
      return t('accounts.organizationCategory.cooperative');
    case 'landlord':
      return t('accounts.organizationCategory.landlord');
    default:
      return t('accounts.organizationCategory.other');
  }
};

const ORGANIZATION_CATEGORY_OPTIONS: OrganizationCategory[] = [...ORGANIZATION_CATEGORIES];

/**
 * Create a new account in the unified account graph (an organization, project,
 * or bot). The caller becomes its owner. Optionally nested under a parent
 * account via the `parentAccountId` prop. NOT the cryptographic Commons/DID
 * "identity" — that is a separate concept.
 */
const CreateAccountScreen: React.FC<BaseScreenProps> = ({
  onClose,
  goBack,
  parentAccountId,
}) => {
  const bloomTheme = useTheme();
  const { oxyServices, createAccount, switchToAccount } = useOxy();
  const { t } = useI18n();

  useSurfaceHeader({
    title: t('accounts.create.title') || 'Create account',
    subtitle: t('accounts.create.subtitle')
      || 'Create an account you control. It will have its own profile, members, and apps.',
  });

  const parentId = typeof parentAccountId === 'string' ? parentAccountId : undefined;

  const [kind, setKind] = useState<CreatableAccountKind>('project');
  const [organizationCategory, setOrganizationCategory] = useState<OrganizationCategory>('agency');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>('idle');
  const [usernameMessage, setUsernameMessage] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usernameCheckSeqRef = useRef(0);

  useEffect(() => () => {
    usernameCheckSeqRef.current += 1;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
  }, []);

  // Debounced username availability check
  const checkUsername = useCallback((value: string) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    if (!value || value.length < 3) {
      setUsernameStatus(value.length > 0 ? 'invalid' : 'idle');
      setUsernameMessage(
        value.length > 0
          ? (t('accounts.create.username.tooShort') || 'Username must be at least 3 characters')
          : '',
      );
      return;
    }

    if (!USERNAME_REGEX.test(value)) {
      setUsernameStatus('invalid');
      setUsernameMessage(
        t('accounts.create.username.invalidChars') || 'Only letters, numbers, hyphens, and underscores',
      );
      return;
    }

    setUsernameStatus('checking');
    setUsernameMessage('');

    const seq = ++usernameCheckSeqRef.current;
    debounceTimerRef.current = setTimeout(async () => {
      try {
        const result = await oxyServices.checkUsernameAvailability(value);
        if (seq !== usernameCheckSeqRef.current) return;
        setUsernameStatus(result.available ? 'available' : 'taken');
        setUsernameMessage(
          result.message
          || (result.available
            ? (t('accounts.create.username.available') || 'Username is available')
            : (t('accounts.create.username.taken') || 'Username is taken')),
        );
      } catch {
        if (seq !== usernameCheckSeqRef.current) return;
        setUsernameStatus('idle');
        setUsernameMessage(t('accounts.create.username.checkFailed') || 'Could not check availability');
      }
    }, DEBOUNCE_MS);
  }, [oxyServices, t]);

  const handleUsernameChange = useCallback((value: string) => {
    const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    setUsername(cleaned);
    checkUsername(cleaned);
  }, [checkUsername]);

  const canCreate = usernameStatus === 'available' && displayName.trim().length > 0 && !isCreating;

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;

    setIsCreating(true);
    try {
      // Split display name into first/last
      const nameParts = displayName.trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;

      const input: CreateAccountInput = {
        kind,
        username,
        name: { first: firstName, last: lastName },
        bio: bio.trim() || undefined,
        ...(kind === 'organization' ? { organizationCategory } : null),
        ...(parentId ? { parentAccountId: parentId } : null),
      };
      const account = await createAccount(input);

      toast.success(t('accounts.create.toasts.success') || 'Account created');

      // Switch INTO the new account (real-session switch — the whole app becomes
      // it). Best-effort: creation already succeeded, so a switch hiccup should
      // not surface as a create failure.
      if (account.accountId) {
        await switchToAccount(account.accountId).catch(() => undefined);
      }

      onClose?.();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : (t('accounts.create.toasts.failed') || 'Failed to create account');
      toast.error(message);
    } finally {
      setIsCreating(false);
    }
  }, [canCreate, kind, organizationCategory, username, displayName, bio, parentId, createAccount, switchToAccount, onClose, t]);

  // Status icon + color shown alongside the username field message
  const usernameIsInvalid = usernameStatus === 'taken' || usernameStatus === 'invalid';
  const statusColor = usernameStatus === 'available'
    ? bloomTheme.colors.success
    : usernameIsInvalid
      ? bloomTheme.colors.negative
      : bloomTheme.colors.textSecondary;

  const title = t('accounts.create.title') || 'Create account';

  return (
    <View className="gap-space-16 px-screen-margin pt-space-16 pb-space-32">

      {/* Account type — canonical grouped selection rows (checkmark on the chosen one) */}
      <SettingsListGroup title={t('accounts.create.typeSection') || 'Account type'}>
        {KIND_OPTIONS.map((option) => {
          const selected = option.value === kind;
          return (
            <SettingsListItem
              key={option.value}
              icon={(
                <Ionicons
                  name={option.icon}
                  size={22}
                  color={selected ? bloomTheme.colors.primary : bloomTheme.colors.icon}
                />
              )}
              title={kindLabel(t, option.value)}
              description={kindDescription(t, option.value)}
              onPress={() => setKind(option.value)}
              showChevron={false}
              rightElement={selected ? (
                <Ionicons name="checkmark-circle" size={20} color={bloomTheme.colors.primary} />
              ) : undefined}
              accessibilityLabel={kindLabel(t, option.value)}
            />
          );
        })}
      </SettingsListGroup>

      {/* Organization category — grouped selection rows, shown only for organizations */}
      {kind === 'organization' ? (
        <SettingsListGroup title={t('accounts.create.organizationCategory.label')}>
          {ORGANIZATION_CATEGORY_OPTIONS.map((option) => {
            const selected = option === organizationCategory;
            return (
              <SettingsListItem
                key={option}
                title={organizationCategoryLabel(t, option)}
                onPress={() => setOrganizationCategory(option)}
                showChevron={false}
                rightElement={selected ? (
                  <Ionicons name="checkmark-circle" size={20} color={bloomTheme.colors.primary} />
                ) : undefined}
                accessibilityLabel={organizationCategoryLabel(t, option)}
              />
            );
          })}
        </SettingsListGroup>
      ) : null}

      {/* Details — a grouped section card hosting the form fields */}
      <SettingsListGroup title={t('accounts.create.detailsSection') || 'Details'}>
        <View className="p-space-16 gap-space-16">
          {/* Username */}
          <View className="gap-space-8">
            <TextField isInvalid={usernameIsInvalid}>
              <TextFieldInput
                floatingLabel
                label={t('accounts.create.username.label') || 'Username'}
                value={username}
                onChangeText={handleUsernameChange}
                isInvalid={usernameIsInvalid}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                maxLength={USERNAME_MAX}
              />
            </TextField>
            {(usernameStatus === 'checking' || usernameMessage) ? (
              <View className="flex-row items-center gap-space-4 px-space-4">
                {usernameStatus === 'checking' ? (
                  <ActivityIndicator size="small" color={bloomTheme.colors.primary} />
                ) : usernameStatus === 'available' ? (
                  <Ionicons name="checkmark-circle" size={16} color={bloomTheme.colors.success} />
                ) : usernameIsInvalid ? (
                  <Ionicons name="alert-circle" size={16} color={bloomTheme.colors.negative} />
                ) : null}
                {usernameMessage ? (
                  <Text className="text-caption font-caption" style={{ color: statusColor }}>
                    {usernameMessage}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>

          {/* Display Name */}
          <TextField>
            <TextFieldInput
              floatingLabel
              label={t('accounts.create.displayName.label') || 'Display name'}
              value={displayName}
              onChangeText={setDisplayName}
              maxLength={DISPLAY_NAME_MAX}
            />
          </TextField>

          {/* Bio */}
          <View className="gap-space-4">
            <TextField>
              <TextFieldInput
                floatingLabel
                label={t('accounts.create.bio.label') || 'Bio (optional)'}
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
        </View>
      </SettingsListGroup>

      {/* Create Button */}
      <Button
        variant="primary"
        onPress={handleCreate}
        disabled={!canCreate}
        loading={isCreating}
        accessibilityLabel={title}
        className="w-full"
      >
        {title}
      </Button>
    </View>
  );
};

export default CreateAccountScreen;
