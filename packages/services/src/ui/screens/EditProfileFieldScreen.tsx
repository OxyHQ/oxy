import React, { useState, useCallback, useMemo } from 'react';
import { View, StyleSheet, type TextInputProps } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Ionicons from '../icons/Ionicons';
import type { BaseScreenProps } from '../types/navigation';
import { useTheme } from '@oxy.so/bloom/theme';
import { Button } from '@oxy.so/bloom/button';
import { TextField, TextFieldInput, TextFieldLabel, TextFieldHint } from '@oxy.so/bloom/text-field';
import { PhoneInput, COUNTRIES, findCountry } from '@oxy.so/bloom/phone-input';
import { Textarea } from '@oxy.so/bloom/textarea';
import { DatePicker } from '@oxy.so/bloom/date-picker';
import { Field } from '@oxy.so/bloom/field';
import {
  USERNAME_INVALID_MESSAGE,
  usernameCheck as usernamePolicyCheck,
} from '@oxy.so/contracts/client';
import { useUsernameAvailability } from '../hooks/useUsernameAvailability';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import type { User } from '@oxy.so/core';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/oxyRuntimeContext';
import { useProfileEditing } from '../hooks/useProfileEditing';
import { toast } from '@oxy.so/bloom/toast';
import { accountNameInvalidKey, accountNameInvalidMessage, isValidAccountName } from '@oxy.so/core';
import { getLinkTitle, getLinkDescription, linksToListItems } from './linkFormat';

/**
 * Field types supported by EditProfileFieldScreen
 */
export type ProfileFieldType =
  | 'displayName'
  | 'username'
  | 'bio'
  | 'phone'
  | 'address'
  | 'birthday'
  | 'location'
  | 'locations'
  | 'links';

/**
 * Field configuration for each field type
 */
interface FieldConfig {
  title: string;
  subtitle?: string;
  fields: Array<{
    key: string;
    label: string;
    placeholder: string;
    type?: 'text' | 'email' | 'textarea';
    validation?: (value: string) => string | undefined;
    inputProps?: Partial<TextInputProps>;
  }>;
  isList?: boolean;
  /** Renders `renderBirthdayPicker` instead of the plain-text `fields`. */
  isDatePicker?: boolean;
}

/**
 * The earliest calendar year the birthday picker offers — matches the
 * platform's own lower bound (`dateOfBirthSchema`, `@oxy.so/contracts`) so a
 * value this picker can produce is never one the API would reject.
 */
const MIN_BIRTH_YEAR = 1900;

interface EditProfileFieldScreenProps extends BaseScreenProps {
  /** The field type to edit */
  fieldType?: ProfileFieldType;
}

type EditableListItem = {
  id: string;
  name?: string;
  label?: string;
  url?: string;
  title?: string;
  description?: string;
  image?: string;
  coordinates?: { lat: number; lon: number };
};

/**
 * Pure seeding function: derives the initial `fieldValues` / `listItems` for a
 * given field type from the active account snapshot. Called ONCE per state via
 * lazy `useState` initializers — never from an effect — so a background
 * `refreshSessions()` / `useCurrentUser()` swap of the `user` reference can't
 * wipe in-progress typing. Each editor mounts with a fixed `fieldType`, so the
 * seed is stable for the lifetime of the mount.
 */
function buildInitialProfileState(
  user: User | null,
  fieldType: ProfileFieldType,
): { fieldValues: Record<string, string>; listItems: EditableListItem[] } {
  if (!user) {
    return { fieldValues: {}, listItems: [] };
  }
  const userData = user;

  if (fieldType === 'locations') {
    const locations = Array.isArray(userData.locations) ? userData.locations : [];
    return {
      fieldValues: {},
      listItems: locations.map((loc, i) => ({
        id: String(loc.id || `location-${i}`),
        name: String(loc.name || ''),
        ...loc,
      })),
    };
  }

  if (fieldType === 'links') {
    const linksMetadata = Array.isArray(userData.linksMetadata) ? userData.linksMetadata : [];
    const links = Array.isArray(userData.links) ? userData.links : [];
    // Prefer rich link metadata; fall back to the plain links array.
    if (linksMetadata.length > 0) {
      return {
        fieldValues: {},
        listItems: linksMetadata.map((link, i) => ({
          ...link,
          id: String(link.id || `link-${i}`),
          url: String(link.url || ''),
          title: String(link.title || getLinkTitle(String(link.url || ''))),
          description: String(link.description || getLinkDescription(String(link.url || ''))),
        })),
      };
    }
    return {
      fieldValues: {},
      listItems: linksToListItems(links),
    };
  }

  // Scalar fields: seed only the keys this field type edits.
  const fieldValues: Record<string, string> = {};
  switch (fieldType) {
    case 'displayName':
      fieldValues.firstName = String(userData.name?.first || '');
      fieldValues.lastName = String(userData.lastName || userData.name?.last || '');
      break;
    case 'birthday':
      // Seeded from `dateOfBirth` ONLY, never the legacy free-text
      // `birthday` — a structured picker needs a real `YYYY-MM-DD`
      // value to select against, and `birthday` has no guaranteed
      // shape (see its own comment in `db/schema/users.ts`). An
      // account whose `dateOfBirth` is not yet set opens the picker
      // empty rather than seeded with a guess.
      fieldValues.dateOfBirth = String(userData.dateOfBirth || '');
      break;
    case 'address':
      fieldValues.address = String(userData.address || '');
      break;
    case 'username':
    case 'bio':
    case 'phone':
      fieldValues[fieldType] = String(userData[fieldType] || '');
      break;
    default:
      break;
  }
  return { fieldValues, listItems: [] };
}

/**
 * EditProfileFieldScreen - A dedicated screen for editing profile fields
 *
 * Navigate to this screen with a fieldType prop to edit that specific field.
 *
 * @example
 * navigate('EditProfileField', { fieldType: 'username' })
 */
const EditProfileFieldScreen: React.FC<EditProfileFieldScreenProps> = ({
  goBack,
  onClose,
  fieldType = 'displayName',
}) => {
  // Editing "my" profile targets the ACTIVE account — writes authenticate as
  // the active session, which IS that account — so the initial field values
  // must mirror the active account (an org/project/bot when switched, else the
  // personal user).
  const { user } = useOxy();
  const { t } = useI18n();
  const { saveProfile, updateField, isSaving } = useProfileEditing();
  const bloomTheme = useTheme();

  // State for field values — seeded ONCE from the active account snapshot at
  // mount via lazy initializers. See buildInitialProfileState: no effect
  // reseeds these, so a background user-ref swap never wipes typing.
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(
    () => buildInitialProfileState(user, fieldType).fieldValues,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});

  // State for list fields (locations, links) — same one-time mount seeding.
  const [listItems, setListItems] = useState<EditableListItem[]>(
    () => buildInitialProfileState(user, fieldType).listItems,
  );
  const [newItemValue, setNewItemValue] = useState('');

  const [phoneCountry, setPhoneCountry] = useState(() => {
    const phone = fieldValues.phone?.replace(/[\s()-]/g, '') || '';
    return (
      [...COUNTRIES]
        .sort((a, b) => b.dial.length - a.dial.length)
        .find((country) => phone.startsWith(`+${country.dial}`))?.iso2 || 'US'
    );
  });
  const phoneDial = findCountry(phoneCountry)?.dial || '1';
  const phoneValue = fieldValues.phone || '';
  const phoneNumber = phoneValue.startsWith(`+${phoneDial}`)
    ? phoneValue.slice(phoneDial.length + 1).trimStart()
    : phoneValue;

  const usernameCheck = useUsernameAvailability(
    fieldValues.username || '',
    fieldType === 'username',
  );

  // The name policy is the account's kind's: an organization a person switched
  // into is named by the title policy, not held to a person's.
  const kind = user?.kind;
  const invalidNameMessage =
    t(`editProfile.items.displayName.${accountNameInvalidKey(kind)}`) ||
    accountNameInvalidMessage(kind);
  // Get field configuration based on fieldType
  const fieldConfig = useMemo((): FieldConfig => {
    switch (fieldType) {
      case 'displayName':
        return {
          title: t('editProfile.items.displayName.title') || 'Display Name',
          subtitle:
            t('editProfile.items.displayName.subtitle') ||
            'This is how your name will appear to others',
          fields: [
            {
              key: 'firstName',
              label: t('editProfile.items.displayName.firstName') || 'First Name',
              placeholder:
                t('editProfile.items.displayName.firstNamePlaceholder') || 'Enter first name',
              validation: (value) =>
                isValidAccountName(value, kind) ? undefined : invalidNameMessage,
            },
            {
              key: 'lastName',
              label: t('editProfile.items.displayName.lastName') || 'Last Name',
              placeholder:
                t('editProfile.items.displayName.lastNamePlaceholder') ||
                'Enter last name (optional)',
              validation: (value) =>
                isValidAccountName(value, kind) ? undefined : invalidNameMessage,
            },
          ],
        };
      case 'username':
        return {
          title: t('editProfile.items.username.title') || 'Username',
          subtitle:
            t('editProfile.items.username.subtitle') || 'Your unique identifier on the platform',
          fields: [
            {
              key: 'username',
              label: t('editProfile.items.username.label') || 'Username',
              placeholder: t('editProfile.items.username.placeholder') || 'Choose a username',
              validation: (value) => {
                const checked = usernamePolicyCheck(value, []);
                return checked.ok ? undefined : checked.issue.message;
              },
              inputProps: {
                autoCapitalize: 'none',
                autoCorrect: false,
              },
            },
          ],
        };
      case 'bio':
        return {
          title: t('editProfile.items.bio.title') || 'Bio',
          subtitle: t('editProfile.items.bio.subtitle') || 'Tell people a bit about yourself',
          fields: [
            {
              key: 'bio',
              label: t('editProfile.items.bio.label') || 'Bio',
              placeholder:
                t('editProfile.items.bio.placeholder') || 'Tell people about yourself...',
              type: 'textarea',
              inputProps: {
                multiline: true,
                numberOfLines: 6,
                textAlignVertical: 'top',
              },
            },
          ],
        };
      case 'phone':
        return {
          title: t('editProfile.items.phone.title') || 'Phone Number',
          subtitle: t('editProfile.items.phone.subtitle') || 'Your contact phone number',
          fields: [
            {
              key: 'phone',
              label: t('editProfile.items.phone.label') || 'Phone Number',
              placeholder: t('editProfile.items.phone.placeholder') || 'Enter your phone number',
              inputProps: {
                keyboardType: 'phone-pad',
                autoCapitalize: 'none',
                autoCorrect: false,
              },
            },
          ],
        };
      case 'address':
        return {
          title: t('editProfile.items.address.title') || 'Address',
          subtitle: t('editProfile.items.address.subtitle') || 'Your physical address',
          fields: [
            {
              key: 'address',
              label: t('editProfile.items.address.label') || 'Address',
              placeholder: t('editProfile.items.address.placeholder') || 'Enter your address',
              type: 'textarea',
              inputProps: {
                multiline: true,
                numberOfLines: 3,
                textAlignVertical: 'top',
              },
            },
          ],
        };
      case 'birthday':
        return {
          title: t('editProfile.items.birthday.title') || 'Birthday',
          subtitle: t('editProfile.items.birthday.subtitle') || 'Your date of birth',
          // The shared date picker writes the same date-only API field.
          fields: [
            {
              key: 'dateOfBirth',
              label: t('editProfile.items.birthday.label') || 'Birthday',
              placeholder: t('editProfile.items.birthday.placeholder') || 'YYYY-MM-DD',
            },
          ],
          isDatePicker: true,
        };
      case 'locations':
        return {
          title: t('editProfile.items.locations.title') || 'Locations',
          subtitle: t('editProfile.items.locations.subtitle') || "Places you've been or live",
          fields: [],
          isList: true,
        };
      case 'links':
        return {
          title: t('editProfile.items.links.title') || 'Links',
          subtitle:
            t('editProfile.items.links.subtitle') || 'Share your website, social profiles, etc.',
          fields: [],
          isList: true,
        };
      default:
        return {
          title: 'Edit Field',
          fields: [],
        };
    }
  }, [fieldType, t, kind, invalidNameMessage]);

  // Field change handler
  const handleFieldChange = useCallback(
    (key: string, value: string) => {
      setFieldValues((prev) => ({ ...prev, [key]: value }));
      if (fieldErrors[key]) {
        setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
      }
    },
    [fieldErrors],
  );

  // Validate all fields
  const validateFields = useCallback((): boolean => {
    const errors: Record<string, string | undefined> = {};
    let isValid = true;

    for (const field of fieldConfig.fields) {
      if (field.validation) {
        const error = field.validation(fieldValues[field.key] || '');
        if (error) {
          errors[field.key] = error;
          isValid = false;
        }
      }
    }

    setFieldErrors(errors);
    return isValid;
  }, [fieldConfig.fields, fieldValues]);

  // Add item to list
  const handleAddItem = useCallback(() => {
    if (!newItemValue.trim()) return;

    if (fieldType === 'locations') {
      const newItem = {
        id: `location-${Date.now()}`,
        name: newItemValue.trim(),
      };
      setListItems((prev) => [...prev, newItem]);
    } else if (fieldType === 'links') {
      const newItem = {
        id: `link-${Date.now()}`,
        url: newItemValue.trim(),
        title: getLinkTitle(newItemValue.trim()),
        description: getLinkDescription(newItemValue.trim()),
      };
      setListItems((prev) => [...prev, newItem]);
    }
    setNewItemValue('');
  }, [newItemValue, fieldType]);

  // Remove item from list
  const handleRemoveItem = useCallback((id: string) => {
    setListItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  // Save handler
  const handleSave = async () => {
    if (isSaving || (fieldType === 'username' && !usernameCheck.canSave)) return;
    if (fieldConfig.isList) {
      let success = false;
      if (fieldType === 'locations') {
        success = await saveProfile({
          locations: listItems.map((item) => ({
            id: item.id,
            name: String(item.name || ''),
            ...(item.label !== undefined && { label: String(item.label) }),
            ...(item.coordinates !== undefined && {
              coordinates: item.coordinates as { lat: number; lon: number },
            }),
          })),
        });
      } else if (fieldType === 'links') {
        success = await saveProfile({
          linksMetadata: listItems.map((item) => ({
            id: item.id,
            url: String(item.url || ''),
            title: String(item.title || getLinkTitle(String(item.url || ''))),
            description: String(item.description || getLinkDescription(String(item.url || ''))),
            ...(item.image !== undefined && { image: String(item.image) }),
          })),
          links: listItems.map((item) => String(item.url || '')),
        });
      }
      if (success) {
        toast.success(t('common.saved') || 'Saved successfully');
        (onClose || goBack)?.();
      }
    } else {
      if (!validateFields()) return;

      let success = false;
      if (fieldType === 'displayName') {
        success = await saveProfile({
          firstName: fieldValues.firstName,
          lastName: fieldValues.lastName,
        });
      } else {
        const key = fieldConfig.fields[0]?.key;
        if (key) {
          success = await updateField(
            key,
            key === 'username' ? usernameCheck.candidate : fieldValues[key],
          );
        }
      }

      if (success) {
        toast.success(t('common.saved') || 'Saved successfully');
        (onClose || goBack)?.();
      }
    }
  };

  const saveDisabled = isSaving || (fieldType === 'username' && !usernameCheck.canSave);
  useSurfaceHeader({
    title: fieldConfig.title,
    subtitle: fieldConfig.subtitle,
    primaryAction: {
      label: t('common.save') || 'Save',
      onPress: () => void handleSave(),
      loading: isSaving,
      disabled: saveDisabled,
    },
  });

  // Render a single field input
  const renderField = (field: FieldConfig['fields'][0], index: number) => {
    const error =
      fieldErrors[field.key] ||
      (field.key === 'username'
        ? usernameCheck.status === 'invalid'
          ? usernameCheck.invalid
          : usernameCheck.status === 'taken'
            ? t('accounts.create.username.taken')
            : usernameCheck.status === 'error'
              ? t('accounts.create.username.checkFailed')
              : undefined
        : undefined);

    if (field.key === 'phone') {
      return (
        <PhoneInput
          key={field.key}
          label={field.label}
          placeholder={field.placeholder}
          country={phoneCountry}
          value={phoneNumber}
          disabled={isSaving}
          isInvalid={Boolean(error)}
          hint={error}
          onCountryChange={(iso2, country) => {
            setPhoneCountry(iso2);
            handleFieldChange('phone', phoneNumber.trim() ? `+${country.dial}${phoneNumber}` : '');
          }}
          onValueChange={(value) => {
            const trimmed = value.trim();
            if (trimmed.startsWith('+')) {
              const international = trimmed.replace(/[\s()-]/g, '');
              const country = [...COUNTRIES]
                .sort((a, b) => b.dial.length - a.dial.length)
                .find((candidate) => international.startsWith(`+${candidate.dial}`));
              if (country) setPhoneCountry(country.iso2);
              handleFieldChange('phone', international);
            } else {
              handleFieldChange('phone', trimmed ? `+${phoneDial}${value}` : '');
            }
          }}
        />
      );
    }
    if (field.type === 'textarea') {
      return (
        <Textarea
          key={field.key}
          label={field.label}
          placeholder={field.placeholder}
          value={fieldValues[field.key] || ''}
          onValueChange={(value) => handleFieldChange(field.key, value)}
          rows={field.key === 'bio' ? 6 : 3}
          disabled={isSaving}
          isInvalid={Boolean(error)}
          hint={error}
          autoFocus={index === 0}
        />
      );
    }

    return (
      <Field
        key={field.key}
        label={field.label}
        error={error}
        disabled={isSaving}
        description={
          field.key === 'username'
            ? usernameCheck.status === 'checking'
              ? t('editProfile.items.username.checking')
              : usernameCheck.status === 'available'
                ? t('accounts.create.username.available')
                : USERNAME_INVALID_MESSAGE
            : undefined
        }
      >
        <TextField>
          <TextFieldInput
            label={field.label}
            placeholder={field.placeholder}
            value={fieldValues[field.key] || ''}
            onChangeText={(value) => handleFieldChange(field.key, value)}
            isInvalid={Boolean(error)}
            autoFocus={index === 0}
            {...field.inputProps}
          />
        </TextField>
      </Field>
    );
  };

  // Keep birthdays date-only: local calendar components avoid UTC day shifts.
  const renderBirthdayPicker = () => {
    const value = fieldValues.dateOfBirth;
    const parts = value ? value.split('-').map(Number) : null;
    return (
      <View className="gap-space-8">
        <TextFieldLabel>{fieldConfig.title}</TextFieldLabel>
        <DatePicker
          value={parts ? new Date(parts[0], parts[1] - 1, parts[2]) : null}
          minDate={new Date(MIN_BIRTH_YEAR, 0, 1)}
          maxDate={new Date()}
          accessibilityLabel={fieldConfig.title}
          placeholder={fieldConfig.fields[0].placeholder}
          disabled={isSaving}
          onChange={(date) =>
            handleFieldChange(
              'dateOfBirth',
              date
                ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
                : '',
            )
          }
        />
      </View>
    );
  };

  // Render list content (locations or links)
  const renderListContent = () => {
    const addLabel =
      fieldType === 'locations'
        ? t('editProfile.items.locations.add') || 'Add Location'
        : t('editProfile.items.links.add') || 'Add Link';
    const listTitle =
      fieldType === 'locations'
        ? t('editProfile.items.locations.yourLocations') || 'Your Locations'
        : t('editProfile.items.links.yourLinks') || 'Your Links';

    return (
      <>
        <View className="flex-row items-center gap-space-8">
          <View className="flex-1">
            <TextFieldLabel>{addLabel}</TextFieldLabel>
            <TextField disabled={isSaving}>
              <TextFieldInput
                label={addLabel}
                value={newItemValue}
                onChangeText={setNewItemValue}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={handleAddItem}
                returnKeyType="done"
                keyboardType={fieldType === 'links' ? 'url' : 'default'}
              />
            </TextField>
          </View>
          <Button
            onPress={handleAddItem}
            disabled={isSaving || !newItemValue.trim()}
            accessibilityLabel={addLabel}
            icon={<Ionicons name="add" size={20} color={bloomTheme.colors.primaryForeground} />}
            iconOnly
            tone="neutral"
            appearance="outline"
          />
        </View>

        {listItems.length > 0 && (
          <GroupedSection title={`${listTitle} (${listItems.length})`}>
            {listItems.map((item) => (
              <GroupedSectionItem
                key={item.id}
                title={String(fieldType === 'locations' ? item.name : item.title || item.url)}
                description={fieldType === 'links' ? String(item.url) : undefined}
                icon={
                  fieldType === 'links' && item.image ? (
                    <ExpoImage
                      source={{ uri: item.image }}
                      style={styles.linkImage}
                      contentFit="cover"
                    />
                  ) : undefined
                }
                rightElement={
                  <Button
                    onPress={() => handleRemoveItem(item.id)}
                    disabled={isSaving}
                    accessibilityLabel={`${t('common.remove') || 'Remove'} ${fieldType === 'locations' ? item.name : item.title || item.url}`}
                    icon={
                      <Ionicons name="trash-outline" size={18} color={bloomTheme.colors.negative} />
                    }
                    iconOnly
                    tone="danger"
                    appearance="plain"
                  />
                }
              />
            ))}
          </GroupedSection>
        )}
      </>
    );
  };

  return (
    <View className="px-screen-margin pt-space-16 pb-space-32 gap-space-24">
      <View style={{ gap: 20 }}>
        {fieldConfig.isList
          ? renderListContent()
          : fieldConfig.isDatePicker
            ? renderBirthdayPicker()
            : fieldConfig.fields.map(renderField)}
        {fieldType === 'username' && (
          <View style={{ gap: 12 }}>
            {usernameCheck.status === 'error' && (
              <Button appearance="plain" tone="neutral" onPress={usernameCheck.retry}>
                {t('common.retry')}
              </Button>
            )}
            <TextFieldHint>{t('editProfile.items.username.changeHint')}</TextFieldHint>
          </View>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  linkImage: {
    width: 40,
    height: 40,
    borderRadius: 8,
  },
});

export default React.memo(EditProfileFieldScreen);
