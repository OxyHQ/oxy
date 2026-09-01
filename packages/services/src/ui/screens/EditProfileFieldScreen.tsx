import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
    View,
    Image,
    StyleSheet,
    TouchableOpacity,
    type TextInputProps,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { BaseScreenProps } from '../types/navigation';
import { useTheme } from '@oxyhq/bloom/theme';
import { Text } from '@oxyhq/bloom/typography';
import { Button } from '@oxyhq/bloom/button';
import { TextField, TextFieldInput } from '@oxyhq/bloom/text-field';
import { normalizeTheme } from '@oxyhq/core';
import type { User } from '@oxyhq/core';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { SurfaceHeaderAction } from '../components/SurfaceHeaderAction';
import { useOxy } from '../context/OxyContext';
import { useProfileEditing } from '../hooks/useProfileEditing';
import { toast } from '@oxyhq/bloom';
import { EMAIL_REGEX, isValidDisplayName } from '@oxyhq/core';
import { getLinkTitle, getLinkDescription, linksToListItems } from './linkFormat';

/**
 * Field types supported by EditProfileFieldScreen
 */
export type ProfileFieldType =
    | 'displayName'
    | 'username'
    | 'email'
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
}

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
            fieldValues.birthday = String(userData.birthday || userData.dateOfBirth || '');
            break;
        case 'address':
            fieldValues.address = String(userData.address || '');
            break;
        case 'username':
        case 'email':
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
    theme,
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
    const normalizedTheme = normalizeTheme(theme);

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

    // Get field configuration based on fieldType
    const fieldConfig = useMemo((): FieldConfig => {
        switch (fieldType) {
            case 'displayName':
                return {
                    title: t('editProfile.items.displayName.title') || 'Display Name',
                    subtitle: t('editProfile.items.displayName.subtitle') || 'This is how your name will appear to others',
                    fields: [
                        {
                            key: 'firstName',
                            label: t('editProfile.items.displayName.firstName') || 'First Name',
                            placeholder: t('editProfile.items.displayName.firstNamePlaceholder') || 'Enter first name',
                            validation: (value) =>
                                isValidDisplayName(value)
                                    ? undefined
                                    : (t('editProfile.items.displayName.invalidChars')
                                        || 'Use letters and spaces only'),
                        },
                        {
                            key: 'lastName',
                            label: t('editProfile.items.displayName.lastName') || 'Last Name',
                            placeholder: t('editProfile.items.displayName.lastNamePlaceholder') || 'Enter last name (optional)',
                            validation: (value) =>
                                isValidDisplayName(value)
                                    ? undefined
                                    : (t('editProfile.items.displayName.invalidChars')
                                        || 'Use letters and spaces only'),
                        },
                    ],
                };
            case 'username':
                return {
                    title: t('editProfile.items.username.title') || 'Username',
                    subtitle: t('editProfile.items.username.subtitle') || 'Your unique identifier on the platform',
                    fields: [
                        {
                            key: 'username',
                            label: t('editProfile.items.username.label') || 'Username',
                            placeholder: t('editProfile.items.username.placeholder') || 'Choose a username',
                            validation: (value) => {
                                if (!value.trim()) {
                                    return t('editProfile.items.username.required') || 'Username is required';
                                }
                                if (value.length < 3) {
                                    return t('editProfile.items.username.tooShort') || 'Username must be at least 3 characters';
                                }
                                return undefined;
                            },
                            inputProps: {
                                autoCapitalize: 'none',
                                autoCorrect: false,
                            },
                        },
                    ],
                };
            case 'email':
                return {
                    title: t('editProfile.items.email.title') || 'Email',
                    subtitle: t('editProfile.items.email.subtitle') || 'Your primary email address',
                    fields: [
                        {
                            key: 'email',
                            label: t('editProfile.items.email.label') || 'Email Address',
                            placeholder: t('editProfile.items.email.placeholder') || 'Enter your email address',
                            type: 'email',
                            validation: (value) => {
                                if (!EMAIL_REGEX.test(value)) {
                                    return t('editProfile.items.email.invalid') || 'Please enter a valid email address';
                                }
                                return undefined;
                            },
                            inputProps: {
                                keyboardType: 'email-address',
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
                            placeholder: t('editProfile.items.bio.placeholder') || 'Tell people about yourself...',
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
                    fields: [
                        {
                            key: 'birthday',
                            label: t('editProfile.items.birthday.label') || 'Birthday',
                            placeholder: t('editProfile.items.birthday.placeholder') || 'YYYY-MM-DD',
                            inputProps: {
                                autoCapitalize: 'none',
                                autoCorrect: false,
                            },
                        },
                    ],
                };
            case 'locations':
                return {
                    title: t('editProfile.items.locations.title') || 'Locations',
                    subtitle: t('editProfile.items.locations.subtitle') || 'Places you\'ve been or live',
                    fields: [],
                    isList: true,
                };
            case 'links':
                return {
                    title: t('editProfile.items.links.title') || 'Links',
                    subtitle: t('editProfile.items.links.subtitle') || 'Share your website, social profiles, etc.',
                    fields: [],
                    isList: true,
                };
            default:
                return {
                    title: 'Edit Field',
                    fields: [],
                };
        }
    }, [fieldType, t]);

    // Field change handler
    const handleFieldChange = useCallback((key: string, value: string) => {
        setFieldValues(prev => ({ ...prev, [key]: value }));
        if (fieldErrors[key]) {
            setFieldErrors(prev => ({ ...prev, [key]: undefined }));
        }
    }, [fieldErrors]);

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
            setListItems(prev => [...prev, newItem]);
        } else if (fieldType === 'links') {
            const newItem = {
                id: `link-${Date.now()}`,
                url: newItemValue.trim(),
                title: getLinkTitle(newItemValue.trim()),
                description: getLinkDescription(newItemValue.trim()),
            };
            setListItems(prev => [...prev, newItem]);
        }
        setNewItemValue('');
    }, [newItemValue, fieldType]);

    // Remove item from list
    const handleRemoveItem = useCallback((id: string) => {
        setListItems(prev => prev.filter(item => item.id !== id));
    }, []);

    // Save handler
    const handleSave = async () => {
        if (fieldConfig.isList) {
            let success = false;
            if (fieldType === 'locations') {
                success = await saveProfile({
                    locations: listItems.map(item => ({
                        id: item.id,
                        name: String(item.name || ''),
                        ...(item.label !== undefined && { label: String(item.label) }),
                        ...(item.coordinates !== undefined && { coordinates: item.coordinates as { lat: number; lon: number } }),
                    })),
                });
            } else if (fieldType === 'links') {
                success = await saveProfile({
                    linksMetadata: listItems.map(item => ({
                        id: item.id,
                        url: String(item.url || ''),
                        title: String(item.title || getLinkTitle(String(item.url || ''))),
                        description: String(item.description || getLinkDescription(String(item.url || ''))),
                        ...(item.image !== undefined && { image: String(item.image) }),
                    })),
                    links: listItems.map(item => String(item.url || '')),
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
                    success = await updateField(key, fieldValues[key]);
                }
            }

            if (success) {
                toast.success(t('common.saved') || 'Saved successfully');
                (onClose || goBack)?.();
            }
        }
    };

    // Contribute the field title/subtitle + a Save action into the Dialog's own
    // nav header (this screen renders no header of its own). `handleSave` closes
    // over the live form values, so route it through a ref to keep the Save node
    // stable across keystrokes (only re-created when the saving state flips).
    const handleSaveRef = useRef(handleSave);
    handleSaveRef.current = handleSave;
    const onSavePress = useCallback(() => { void handleSaveRef.current(); }, []);
    const saveAction = useMemo(
        () => (
            <SurfaceHeaderAction
                label={isSaving ? (t('common.saving') || 'Saving…') : (t('common.save') || 'Save')}
                onPress={onSavePress}
                loading={isSaving}
                disabled={isSaving}
            />
        ),
        [isSaving, onSavePress, t],
    );
    useSurfaceHeader({ title: fieldConfig.title, subtitle: fieldConfig.subtitle, right: saveAction });

    // Render a single field input
    const renderField = (field: FieldConfig['fields'][0], index: number) => {
        const error = fieldErrors[field.key];

        return (
            <View key={field.key} className="gap-space-8">
                <TextField isInvalid={Boolean(error)}>
                    <TextFieldInput
                        floatingLabel
                        label={field.label}
                        value={fieldValues[field.key] || ''}
                        onChangeText={(value) => handleFieldChange(field.key, value)}
                        isInvalid={Boolean(error)}
                        autoFocus={index === 0}
                        {...field.inputProps}
                    />
                </TextField>
                {error && (
                    <Text
                        className="text-caption px-space-4"
                        style={{ color: bloomTheme.colors.negative }}
                    >
                        {error}
                    </Text>
                )}
            </View>
        );
    };

    // Render list content (locations or links)
    const renderListContent = () => {
        const addLabel = fieldType === 'locations'
            ? (t('editProfile.items.locations.add') || 'Add Location')
            : (t('editProfile.items.links.add') || 'Add Link');
        const listTitle = fieldType === 'locations'
            ? (t('editProfile.items.locations.yourLocations') || 'Your Locations')
            : (t('editProfile.items.links.yourLinks') || 'Your Links');

        return (
            <>
                <View className="flex-row items-center gap-space-8">
                    <View className="flex-1">
                        <TextField>
                            <TextFieldInput
                                floatingLabel
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
                        variant="icon"
                        onPress={handleAddItem}
                        disabled={!newItemValue.trim()}
                        accessibilityLabel={addLabel}
                        icon={<Ionicons name="add" size={20} color={bloomTheme.colors.primaryForeground} />}
                    />
                </View>

                {listItems.length > 0 && (
                    <View className="mt-space-8 gap-space-12">
                        <Text className="text-sectionTitle font-sectionTitle text-text">
                            {listTitle} ({listItems.length})
                        </Text>
                        {listItems.map((item) => (
                            <View
                                key={item.id}
                                className="flex-row items-center gap-space-12 p-space-16 rounded-radius-12 border-hairline border-border-image bg-fill"
                            >
                                {fieldType === 'links' && item.image && (
                                    <Image source={{ uri: item.image }} style={styles.linkImage} />
                                )}
                                <View className="flex-1 gap-space-4">
                                    <Text className="text-subtitle font-subtitle text-text" numberOfLines={1}>
                                        {fieldType === 'locations' ? item.name : (item.title || item.url)}
                                    </Text>
                                    {fieldType === 'links' && (
                                        <Text className="text-bodySmall font-bodySmall text-text-secondary" numberOfLines={1}>
                                            {item.url}
                                        </Text>
                                    )}
                                </View>
                                <TouchableOpacity
                                    onPress={() => handleRemoveItem(item.id)}
                                    className="p-space-8"
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.remove') || 'Remove'}
                                >
                                    <Ionicons name="trash-outline" size={18} color={bloomTheme.colors.negative} />
                                </TouchableOpacity>
                            </View>
                        ))}
                    </View>
                )}
            </>
        );
    };

    return (
        <View className="px-screen-margin pt-space-16 pb-space-32 gap-space-24">
            {/* Form Content */}
            <View className="gap-space-16 p-space-16 rounded-radius-20 bg-fill">
                {fieldConfig.isList ? renderListContent() : fieldConfig.fields.map(renderField)}
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
