import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
    View,
    Image,
    StyleSheet,
    TouchableOpacity,
    type TextInputProps,
} from 'react-native';
import Ionicons from '../icons/Ionicons';
import type { BaseScreenProps } from '../types/navigation';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import {
    Select,
    SelectContent,
    SelectIcon,
    SelectItem,
    SelectItemIndicator,
    SelectItemText,
    SelectTrigger,
    SelectValue,
} from '@oxy.so/bloom/select';
import { normalizeTheme } from '@oxy.so/core';
import type { User } from '@oxy.so/core';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { SurfaceHeaderAction } from '../components/SurfaceHeaderAction';
import { useOxy } from '../context/OxyContext';
import { useProfileEditing } from '../hooks/useProfileEditing';
import { toast } from '@oxy.so/bloom/toast';
import { EMAIL_REGEX, DISPLAY_NAME_INVALID_MESSAGE, isValidDisplayName } from '@oxy.so/core';
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
    /** Renders `renderBirthdayPicker` instead of the plain-text `fields`. */
    isDatePicker?: boolean;
}

/**
 * The earliest calendar year the birthday picker offers — matches the
 * platform's own lower bound (`dateOfBirthSchema`, `@oxy.so/contracts`) so a
 * value this picker can produce is never one the API would reject.
 */
const MIN_BIRTH_YEAR = 1900;

/** `MIN_BIRTH_YEAR` through the current year, most recent first. */
function birthYearOptions(): Array<{ value: string; label: string }> {
    const currentYear = new Date().getUTCFullYear();
    const years: Array<{ value: string; label: string }> = [];
    for (let year = currentYear; year >= MIN_BIRTH_YEAR; year--) {
        years.push({ value: String(year), label: String(year) });
    }
    return years;
}

/**
 * Month names are not run through `t()` here: this SDK has no existing
 * calendar-month translation catalogue to hook into, and inventing one is out
 * of scope for wiring up the date picker itself. English month names are a
 * known, deliberate limitation of this pass.
 */
const MONTH_OPTIONS: Array<{ value: string; label: string }> = [
    { value: '01', label: 'January' },
    { value: '02', label: 'February' },
    { value: '03', label: 'March' },
    { value: '04', label: 'April' },
    { value: '05', label: 'May' },
    { value: '06', label: 'June' },
    { value: '07', label: 'July' },
    { value: '08', label: 'August' },
    { value: '09', label: 'September' },
    { value: '10', label: 'October' },
    { value: '11', label: 'November' },
    { value: '12', label: 'December' },
];

/**
 * Real Gregorian days in `month` (1-12) of `year`, leap years included — the
 * same rule `dateOfBirthSchema` (`@oxy.so/contracts`) and the migration
 * backfill (`drizzle/0087_next_green_goblin.sql`) both apply, written a third
 * time here because a picker's OWN day list must bound itself before the
 * value ever reaches either of them.
 */
function daysInMonth(year: number, month: number): number {
    const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const DAYS_PER_MONTH = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return DAYS_PER_MONTH[month - 1];
}

/** Day options for the current year/month selection — 31 while either is unset. */
function dayOptions(year: string, month: string): Array<{ value: string; label: string }> {
    const count = year && month ? daysInMonth(Number(year), Number(month)) : 31;
    return Array.from({ length: count }, (_, index) => {
        const day = String(index + 1).padStart(2, '0');
        return { value: day, label: day };
    });
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
                                        || DISPLAY_NAME_INVALID_MESSAGE),
                        },
                        {
                            key: 'lastName',
                            label: t('editProfile.items.displayName.lastName') || 'Last Name',
                            placeholder: t('editProfile.items.displayName.lastNamePlaceholder') || 'Enter last name (optional)',
                            validation: (value) =>
                                isValidDisplayName(value)
                                    ? undefined
                                    : (t('editProfile.items.displayName.invalidChars')
                                        || DISPLAY_NAME_INVALID_MESSAGE),
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
                    // One entry, naming the field `handleSave`'s generic branch writes
                    // (`fieldConfig.fields[0]?.key`) — `renderBirthdayPicker` renders the
                    // actual day/month/year controls; this array is never mapped through
                    // `renderField` for this field type (see `isDatePicker` below).
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

    // The birthday picker's three pieces, seeded once from the same
    // one-time-mount value `fieldValues.dateOfBirth` already carries (empty
    // string parts when unset). Kept separate from `fieldValues` because a
    // `Select` needs its OWN current value per control; each change handler
    // below composes the three back into the single `dateOfBirth` field
    // `handleSave` actually writes, in the event handler itself rather than
    // an effect.
    const [dobYear, setDobYear] = useState(() => (fieldValues.dateOfBirth || '').split('-')[0] || '');
    const [dobMonth, setDobMonth] = useState(() => (fieldValues.dateOfBirth || '').split('-')[1] || '');
    const [dobDay, setDobDay] = useState(() => (fieldValues.dateOfBirth || '').split('-')[2] || '');

    // A partial selection (e.g. year and month but no day yet) writes ''`,
    // which `updateField`/the API's `dateOfBirth` write path already treats
    // as "clear" — the same behaviour a fully-erased text field would have
    // had. There is deliberately no separate "incomplete date" error: the
    // three controls are either all filled (a real date) or the field is
    // unset, and both are valid states to save.
    const commitDateOfBirth = useCallback((year: string, month: string, day: string) => {
        handleFieldChange('dateOfBirth', year && month && day ? `${year}-${month}-${day}` : '');
    }, [handleFieldChange]);

    // Changing the year or month can strand a selected day past the new
    // month's length (31 March -> April has none) — clamped down to the new
    // last day rather than left pointing at a day `dayOptions` no longer
    // lists, the same way a native date picker behaves.
    const handleDobYearChange = useCallback((year: string) => {
        const clampedDay = dobDay && dobMonth && Number(dobDay) > daysInMonth(Number(year), Number(dobMonth))
            ? String(daysInMonth(Number(year), Number(dobMonth))).padStart(2, '0')
            : dobDay;
        setDobYear(year);
        setDobDay(clampedDay);
        commitDateOfBirth(year, dobMonth, clampedDay);
    }, [dobMonth, dobDay, commitDateOfBirth]);

    const handleDobMonthChange = useCallback((month: string) => {
        const clampedDay = dobDay && dobYear && Number(dobDay) > daysInMonth(Number(dobYear), Number(month))
            ? String(daysInMonth(Number(dobYear), Number(month))).padStart(2, '0')
            : dobDay;
        setDobMonth(month);
        setDobDay(clampedDay);
        commitDateOfBirth(dobYear, month, clampedDay);
    }, [dobYear, dobDay, commitDateOfBirth]);

    const handleDobDayChange = useCallback((day: string) => {
        setDobDay(day);
        commitDateOfBirth(dobYear, dobMonth, day);
    }, [dobYear, dobMonth, commitDateOfBirth]);

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

    // Render the birthday picker: three `Select`s (day, month, year) rather
    // than a native date-picker dependency. Neither this app nor
    // `@oxy.so/bloom` has one installed, and `Select` is already this
    // design system's cross-platform choice control (a bottom sheet on
    // native, an anchored dropdown on web — see its own docs) with no new
    // dependency to add and no native linking to carry across platforms.
    const renderBirthdayPicker = () => (
        <View className="flex-row gap-space-8">
            <View className="flex-1">
                <Select value={dobMonth} onValueChange={handleDobMonthChange}>
                    <SelectTrigger label={t('editProfile.items.birthday.month') || 'Month'}>
                        <SelectValue placeholder={t('editProfile.items.birthday.month') || 'Month'} />
                        <SelectIcon />
                    </SelectTrigger>
                    <SelectContent
                        label={t('editProfile.items.birthday.month') || 'Month'}
                        items={MONTH_OPTIONS}
                        renderItem={(item) => (
                            <SelectItem value={item.value} label={item.label}>
                                <SelectItemIndicator />
                                <SelectItemText>{item.label}</SelectItemText>
                            </SelectItem>
                        )}
                    />
                </Select>
            </View>
            <View className="flex-1">
                <Select value={dobDay} onValueChange={handleDobDayChange}>
                    <SelectTrigger label={t('editProfile.items.birthday.day') || 'Day'}>
                        <SelectValue placeholder={t('editProfile.items.birthday.day') || 'Day'} />
                        <SelectIcon />
                    </SelectTrigger>
                    <SelectContent
                        label={t('editProfile.items.birthday.day') || 'Day'}
                        items={dayOptions(dobYear, dobMonth)}
                        renderItem={(item) => (
                            <SelectItem value={item.value} label={item.label}>
                                <SelectItemIndicator />
                                <SelectItemText>{item.label}</SelectItemText>
                            </SelectItem>
                        )}
                    />
                </Select>
            </View>
            <View className="flex-1">
                <Select value={dobYear} onValueChange={handleDobYearChange}>
                    <SelectTrigger label={t('editProfile.items.birthday.year') || 'Year'}>
                        <SelectValue placeholder={t('editProfile.items.birthday.year') || 'Year'} />
                        <SelectIcon />
                    </SelectTrigger>
                    <SelectContent
                        label={t('editProfile.items.birthday.year') || 'Year'}
                        items={birthYearOptions()}
                        renderItem={(item) => (
                            <SelectItem value={item.value} label={item.label}>
                                <SelectItemIndicator />
                                <SelectItemText>{item.label}</SelectItemText>
                            </SelectItem>
                        )}
                    />
                </Select>
            </View>
        </View>
    );

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
                {fieldConfig.isList
                    ? renderListContent()
                    : fieldConfig.isDatePicker
                        ? renderBirthdayPicker()
                        : fieldConfig.fields.map(renderField)}
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
