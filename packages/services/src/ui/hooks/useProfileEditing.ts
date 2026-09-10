import { useCallback } from 'react';
import { useUpdateProfile } from './mutations/useAccountMutations';
import { useAuthStore } from '../stores/authStore';
import type { UserProfileUpdate } from '@oxy.so/contracts';

interface ProfileLocation {
    id: string;
    name: string;
    label?: string;
    coordinates?: { lat: number; lon: number };
}

interface ProfileLinkMetadata {
    url: string;
    title?: string;
    description?: string;
    image?: string;
    id: string;
}

export interface ProfileUpdateData {
    firstName?: string;
    lastName?: string;
    username?: string;
    email?: string;
    bio?: string;
    locations?: ProfileLocation[];
    links?: string[];
    linksMetadata?: ProfileLinkMetadata[];
    avatar?: string;
    phone?: string;
    address?: string;
    birthday?: string;
}

type ProfileFieldValue = string | ProfileLocation[] | ProfileLinkMetadata[];

function isProfileLocationArray(value: ProfileFieldValue): value is ProfileLocation[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null && 'name' in item);
}

function isProfileLinkMetadataArray(value: ProfileFieldValue): value is ProfileLinkMetadata[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null && 'url' in item);
}

/**
 * Hook for managing profile editing operations
 * Provides functions to update profile fields and handle saving
 */
export const useProfileEditing = () => {
    const updateProfileMutation = useUpdateProfile();

    /**
     * Save profile updates to the server using TanStack Query
     */
    const saveProfile = useCallback(async (updates: ProfileUpdateData) => {
        // Prepare update object
        const updateData: UserProfileUpdate = {};

        if (updates.username !== undefined) {
            updateData.username = updates.username;
        }
        if (updates.email !== undefined) {
            updateData.email = updates.email;
        }
        if (updates.bio !== undefined) {
            updateData.bio = updates.bio;
        }
        if (updates.locations !== undefined) {
            updateData.locations = updates.locations;
        }
        if (updates.links !== undefined) {
            updateData.links = updates.links;
        }
        if (updates.linksMetadata !== undefined) {
            updateData.linksMetadata = updates.linksMetadata;
        }
        if (updates.avatar !== undefined) {
            updateData.avatar = updates.avatar;
        }
        if (updates.phone !== undefined) {
            updateData.phone = updates.phone;
        }
        if (updates.address !== undefined) {
            updateData.address = updates.address;
        }
        if (updates.birthday !== undefined) {
            updateData.birthday = updates.birthday;
        }

        // Handle name field
        if (updates.firstName !== undefined || updates.lastName !== undefined) {
            const currentUser = useAuthStore.getState().user;
            const currentName = currentUser?.name;
            updateData.name = {
                first: updates.firstName ?? (typeof currentName === 'object' ? currentName?.first : '') ?? '',
                last: updates.lastName ?? (typeof currentName === 'object' ? currentName?.last : '') ?? '',
            };
        }

        try {
            await updateProfileMutation.mutateAsync(updateData);
            return true;
        } catch (error: unknown) {
            // Error toast is handled by the mutation
            return false;
        }
    }, [updateProfileMutation]);

    /**
     * Update a single profile field
     */
    const updateField = useCallback(async (field: string, value: ProfileFieldValue) => {
        const updates: ProfileUpdateData = {};
        
        switch (field) {
            case 'firstName':
                if (typeof value !== 'string') return false;
                updates.firstName = value;
                break;
            case 'username':
                if (typeof value !== 'string') return false;
                updates.username = value;
                break;
            case 'email':
                if (typeof value !== 'string') return false;
                updates.email = value;
                break;
            case 'bio':
                if (typeof value !== 'string') return false;
                updates.bio = value;
                break;
            case 'phone':
                if (typeof value !== 'string') return false;
                updates.phone = value;
                break;
            case 'address':
                if (typeof value !== 'string') return false;
                updates.address = value;
                break;
            case 'birthday':
                if (typeof value !== 'string') return false;
                updates.birthday = value;
                break;
            case 'location':
                if (!isProfileLocationArray(value)) return false;
                updates.locations = value;
                break;
            case 'links':
                if (!isProfileLinkMetadataArray(value)) return false;
                updates.linksMetadata = value;
                updates.links = value.map((link) => link.url);
                break;
            default:
                return false;
        }

        return await saveProfile(updates);
    }, [saveProfile]);

    return {
        saveProfile,
        updateField,
        isSaving: updateProfileMutation.isPending,
    };
};


