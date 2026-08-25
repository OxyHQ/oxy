import type React from 'react';
import { useState, useCallback, useRef, useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { AccountCategoryId, AccountKind, CreateAccountInput } from '@oxyhq/core';
import { accountCategoryLabel, DISPLAY_NAME_INVALID_MESSAGE, isValidDisplayName, MAX_ACCOUNT_CATEGORIES, MAX_DISPLAY_NAME_LENGTH, SELECTABLE_ACCOUNT_CATEGORY_IDS } from '@oxyhq/core';
import {
  isValidUsername,
  stripDisallowedUsernameCharacters,
  USERNAME_INVALID_MESSAGE,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '@oxyhq/contracts';
import type { BaseScreenProps } from '../types/navigation';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useTheme } from '@oxyhq/bloom/theme';
import { Text } from '@oxyhq/bloom/typography';
import { Button } from '@oxyhq/bloom/button';
import { TextField, TextFieldInput } from '@oxyhq/bloom/text-field';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useOxy } from '../context/OxyContext';
import { toast } from '@oxyhq/bloom/toast';

type UsernameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

/**
 * Kind of account this screen can create.
 *
 * A strict subset of what `POST /accounts` accepts, not `Exclude<AccountKind,
 * 'personal'>`: this screen CREATES AND ENTERS in one gesture, so it can only
 * offer kinds an operator may act as — `isActAsEligibleKind` is the same
 * predicate the server enforces on `POST /accounts/:id/switch`.
 *
 * So `channel` is absent here even though `POST /accounts` accepts it from any
 * signed-in caller: a channel is a content identity nobody occupies, and
 * offering it would create the account and then fail the switch. The reason is
 * this screen's own shape, NOT a rule about who may create a channel — that rule
 * changed once already, and a comment tied to it would now be false.
 *
 * Spelling the subset out here is what keeps a newly-added kind from silently
 * inheriting the `project` label in {@link kindLabel}'s fallback.
 */
type CreatableAccountKind = Extract<AccountKind, 'organization' | 'project' | 'bot'>;

const DEBOUNCE_MS = 400;
const DISPLAY_NAME_MAX = MAX_DISPLAY_NAME_LENGTH;
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

/**
 * Only the SELECTABLE ids are offered. The full `ACCOUNT_CATEGORY_IDS` still
 * contains withdrawn ones so that accounts already carrying them keep working —
 * offering them here would be how an account newly acquires one.
 */
const ACCOUNT_CATEGORY_OPTIONS: readonly AccountCategoryId[] = SELECTABLE_ACCOUNT_CATEGORY_IDS;

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
  const { t, locale } = useI18n();

  useSurfaceHeader({
    title: t('accounts.create.title') || 'Create account',
    subtitle: t('accounts.create.subtitle')
      || 'Create an account you control. It will have its own profile, members, and apps.',
  });

  const parentId = typeof parentAccountId === 'string' ? parentAccountId : undefined;

  const [kind, setKind] = useState<CreatableAccountKind>('project');
  /**
   * ORDER IS THE DATA: index 0 is the primary category. Selecting appends,
   * de-selecting removes, and neither sorts — so the list the user assembles is
   * the list that is sent, and the first one they picked stays the primary.
   */
  const [accountCategories, setAccountCategories] = useState<AccountCategoryId[]>([]);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [displayNameError, setDisplayNameError] = useState('');
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

    if (!value || value.length < USERNAME_MIN_LENGTH) {
      setUsernameStatus(value.length > 0 ? 'invalid' : 'idle');
      setUsernameMessage(
        value.length > 0
          ? (t('accounts.create.username.tooShort')
            || `Username must be at least ${USERNAME_MIN_LENGTH} characters`)
          : '',
      );
      return;
    }

    // The ONE policy, from `@oxyhq/contracts`. This screen used to carry a
    // private copy of the rule, and the server it talks to enforced a LOOSER one
    // — so a name this field refused was a name `POST /accounts` would happily
    // have stored.
    if (!isValidUsername(value)) {
      setUsernameStatus('invalid');
      setUsernameMessage(t('accounts.create.username.invalidChars') || USERNAME_INVALID_MESSAGE);
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
    // Filters characters the policy forbids, and nothing else. It no longer
    // lower-cases: `MyBot` is stored as `MyBot`, and uniqueness is decided
    // case-insensitively by the database index rather than by rewriting what
    // somebody typed.
    const cleaned = stripDisallowedUsernameCharacters(value);
    setUsername(cleaned);
    checkUsername(cleaned);
  }, [checkUsername]);

  const handleDisplayNameChange = useCallback((value: string) => {
    setDisplayName(value);
    const trimmed = value.trim();
    if (!trimmed) {
      setDisplayNameError('');
      return;
    }
    const nameParts = trimmed.split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    const invalidPart = [firstName, lastName].find((part) => part && !isValidDisplayName(part));
    setDisplayNameError(
      invalidPart
        ? (t('accounts.create.displayName.invalidChars') || DISPLAY_NAME_INVALID_MESSAGE)
        : '',
    );
  }, [t]);

  /**
   * Append on select, splice out on de-select. Never sorts — appending is what
   * makes the FIRST category the user chose the primary one, and a sort would
   * silently reassign that. De-selecting the primary promotes whatever the user
   * picked next, which is the only interpretation that does not invent a choice
   * on their behalf.
   */
  const toggleAccountCategory = useCallback((category: AccountCategoryId) => {
    setAccountCategories((current) => {
      if (current.includes(category)) {
        return current.filter((entry) => entry !== category);
      }
      if (current.length >= MAX_ACCOUNT_CATEGORIES) return current;
      return [...current, category];
    });
  }, []);

  const canCreate = usernameStatus === 'available'
    && displayName.trim().length > 0
    && !displayNameError
    && !isCreating;

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;

    setIsCreating(true);
    try {
      const input: CreateAccountInput = {
        kind,
        username,
        name: { displayName: displayName.trim() },
        bio: bio.trim() || undefined,
        // Sent in the user's own order, or omitted entirely when empty — the
        // API distinguishes "no categories" from "not stated" only by absence.
        ...(accountCategories.length > 0 ? { accountCategories } : null),
        ...(parentId ? { parentAccountId: parentId } : null),
      };
      const account = await createAccount(input);

      toast.success(t('accounts.create.toasts.success') || 'Account created');

      // Switch INTO the new account (real-session switch — the whole app becomes
      // it). Best-effort: creation already succeeded, so a switch hiccup should
      // not surface as a create failure.
      //
      // That trade holds for a TRANSIENT failure and only for one. A kind the
      // server refuses outright fails DETERMINISTICALLY — `/switch` answers 403
      // every time, never sometimes — and this swallow would turn it into a
      // created account, no switch, and no error anywhere. Which is why
      // `CreatableAccountKind` above is a subset of what `POST /accounts`
      // accepts rather than of what it rejects.
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
  }, [canCreate, kind, accountCategories, username, displayName, bio, parentId, createAccount, switchToAccount, onClose, t]);

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

      {/* Categories — multi-select, shown for every kind this screen can create
          (they are all non-personal). The badge on a selected row is its
          POSITION, so the primary is legible as "1" rather than being a rule the
          user has to be told. */}
      <View className="gap-space-4">
        <SettingsListGroup title={t('accounts.create.accountCategory.label')}>
          {ACCOUNT_CATEGORY_OPTIONS.map((option) => {
            const position = accountCategories.indexOf(option);
            const selected = position >= 0;
            const label = accountCategoryLabel(locale, option);
            return (
              <SettingsListItem
                key={option}
                title={label}
                disabled={!selected && accountCategories.length >= MAX_ACCOUNT_CATEGORIES}
                onPress={() => toggleAccountCategory(option)}
                showChevron={false}
                rightElement={selected ? (
                  <Text className="text-caption-1 font-semibold text-primary">{position + 1}</Text>
                ) : undefined}
                accessibilityLabel={label}
              />
            );
          })}
        </SettingsListGroup>
        <Text className="text-caption font-caption text-text-tertiary px-space-4">
          {t('accounts.create.accountCategory.hint', { max: MAX_ACCOUNT_CATEGORIES })}
        </Text>
      </View>

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
                maxLength={USERNAME_MAX_LENGTH}
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
          <View className="gap-space-4">
            <TextField isInvalid={Boolean(displayNameError)}>
              <TextFieldInput
                floatingLabel
                label={t('accounts.create.displayName.label') || 'Display name'}
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
