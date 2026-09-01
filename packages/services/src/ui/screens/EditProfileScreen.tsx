import type React from 'react';
import { useMemo } from 'react';
import { View } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type { BaseScreenProps } from '../types/navigation';
import { Avatar } from '@oxyhq/bloom/avatar';
import ProfileSummaryCard from '../components/ProfileSummaryCard';
import { SettingsIcon } from '../components/SettingsIcon';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import type { ProfileFieldType } from './EditProfileFieldScreen';

/**
 * EditProfileScreen — the profile-editing HUB.
 *
 * Lists every editable profile field as its own row; each row deep-links into
 * {@link EditProfileFieldScreen} with the matching `fieldType`. The avatar row
 * reuses the exact same `openAvatarPicker` entry point that
 * {@link ManageAccountScreen} uses. This is the single entry into per-field
 * editing — reached from ManageAccount's "Edit profile" row.
 */
const EditProfileScreen: React.FC<BaseScreenProps> = ({ navigate }) => {
    const bloomTheme = useTheme();
    const { t } = useI18n();
    const { user, oxyServices, openAvatarPicker } = useOxy();

    useSurfaceHeader({ title: t('editProfile.title') || 'Edit Profile' });

    const displayName = useMemo(
        () => user?.name?.displayName ?? getNormalizedUserHandle(user) ?? '',
        [user],
    );
    const avatarUri = useMemo(
        () => (user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar, 'thumb') : undefined),
        [user?.avatar, oxyServices],
    );

    const notSet = t('editProfile.notSet') || 'Not set';

    // Current value previews for each row. Typed User fields resolve directly;
    // `locations` is only reachable via the User index signature (typed
    // `unknown`), so it is narrowed defensively.
    const linkPreview = user?.linksMetadata?.[0]?.url ?? user?.links?.[0] ?? notSet;
    const locationPreview = ((): string => {
        const locations = user?.locations;
        const first: unknown = Array.isArray(locations) ? locations[0] : undefined;
        if (first && typeof first === 'object' && 'name' in first && typeof first.name === 'string' && first.name) {
            return first.name;
        }
        return notSet;
    })();

    const goToField = (fieldType: ProfileFieldType) => navigate?.('EditProfileField', { fieldType });

    return (
            <View className="px-screen-margin pt-space-16 pb-space-24">
                {/* Profile card */}
                <ProfileSummaryCard
                    displayName={displayName}
                    avatarUri={avatarUri}
                    lines={[user?.username ? `@${user.username}` : null]}
                />

                {/* Profile picture */}
                <SettingsListGroup title={t('editProfile.sections.profilePicture') || 'Profile Picture'}>
                    <SettingsListItem
                        icon={<SettingsIcon name="camera" color={bloomTheme.colors.primary} />}
                        title={t('editProfile.changeAvatar') || 'Change avatar'}
                        description={t('editProfile.items.avatar.subtitle') || 'Update your profile photo'}
                        onPress={openAvatarPicker}
                        rightElement={<Avatar source={avatarUri} name={displayName} size={32} />}
                    />
                </SettingsListGroup>

                {/* Basic information */}
                <SettingsListGroup title={t('editProfile.sections.basicInfo') || 'Basic Information'}>
                    <SettingsListItem
                        icon={<SettingsIcon name="account" color={bloomTheme.colors.primary} />}
                        title={t('editProfile.items.displayName.title') || 'Display Name'}
                        description={displayName || notSet}
                        onPress={() => goToField('displayName')}
                    />
                    <SettingsListItem
                        icon={<SettingsIcon name="at" color={bloomTheme.colors.info} />}
                        title={t('editProfile.items.username.title') || 'Username'}
                        description={user?.username ? `@${user.username}` : notSet}
                        onPress={() => goToField('username')}
                    />
                    <SettingsListItem
                        icon={<SettingsIcon name="email" color={bloomTheme.colors.success} />}
                        title={t('editProfile.items.email.title') || 'Email'}
                        description={user?.email || notSet}
                        onPress={() => goToField('email')}
                    />
                    <SettingsListItem
                        icon={<SettingsIcon name="phone" color={bloomTheme.colors.warning} />}
                        title={t('editProfile.items.phone.title') || 'Phone Number'}
                        description={user?.phone || notSet}
                        onPress={() => goToField('phone')}
                    />
                </SettingsListGroup>

                {/* About you */}
                <SettingsListGroup title={t('editProfile.sections.about') || 'About You'}>
                    <SettingsListItem
                        icon={<SettingsIcon name="text" color={bloomTheme.colors.primary} />}
                        title={t('editProfile.items.bio.title') || 'Bio'}
                        description={user?.bio || notSet}
                        onPress={() => goToField('bio')}
                    />
                    <SettingsListItem
                        icon={<SettingsIcon name="map-marker" color={bloomTheme.colors.info} />}
                        title={t('editProfile.items.address.title') || 'Address'}
                        description={user?.address || notSet}
                        onPress={() => goToField('address')}
                    />
                    <SettingsListItem
                        icon={<SettingsIcon name="cake-variant" color={bloomTheme.colors.warning} />}
                        title={t('editProfile.items.birthday.title') || 'Birthday'}
                        description={user?.birthday || notSet}
                        onPress={() => goToField('birthday')}
                    />
                    <SettingsListItem
                        icon={<SettingsIcon name="link-variant" color={bloomTheme.colors.success} />}
                        title={t('editProfile.items.links.title') || 'Links'}
                        description={linkPreview}
                        onPress={() => goToField('links')}
                    />
                    <SettingsListItem
                        icon={<SettingsIcon name="map-marker-multiple" color={bloomTheme.colors.primary} />}
                        title={t('editProfile.items.locations.title') || 'Locations'}
                        description={locationPreview}
                        onPress={() => goToField('locations')}
                    />
                </SettingsListGroup>
            </View>
    );
};

export default EditProfileScreen;
