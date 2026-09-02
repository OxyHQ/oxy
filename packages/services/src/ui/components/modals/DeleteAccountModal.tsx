import type React from 'react';
import { useState, useCallback } from 'react';
import { View, Text, TextInput } from 'react-native';
import Ionicons from '../../icons/Ionicons';
import { Button } from '@oxyhq/bloom/button';
import { useTheme } from '@oxyhq/bloom/theme';
import { surfaces, type SurfaceControls } from '@oxyhq/bloom/surfaces';

interface DeleteAccountModalProps {
    /** The presenting surface's controls (from `surfaces.present`). */
    surface: SurfaceControls;
    username: string;
    onDelete: (confirmText: string) => Promise<void>;
    t: (key: string, params?: Record<string, string>) => string | undefined;
}

/**
 * Delete-account confirmation — a rich presented surface (NOT a yes/no confirm):
 * the user must retype their username, then the destructive action runs
 * `onDelete`. On success the surface is dismissed with `true` (the presenter
 * then signs out + closes); cancel dismisses with `false`. Presented via
 * {@link presentDeleteAccount}.
 */
const DeleteAccountModal: React.FC<DeleteAccountModalProps> = ({
    surface,
    username,
    onDelete,
    t,
}) => {
    const theme = useTheme();
    const [confirmUsername, setConfirmUsername] = useState('');
    const [isDeleting, setIsDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isValid = confirmUsername === username;

    const handleDelete = useCallback(async () => {
        if (!isValid) return;

        setError(null);
        setIsDeleting(true);

        try {
            await onDelete(confirmUsername);
            surface.dismiss(true);
        } catch (err: unknown) {
            setError((err instanceof Error ? err.message : null) || t('deleteAccount.error') || 'Failed to delete account');
        } finally {
            setIsDeleting(false);
        }
    }, [isValid, confirmUsername, onDelete, surface, t]);

    const handleCancel = useCallback(() => {
        if (isDeleting) return;
        surface.dismiss(false);
    }, [isDeleting, surface]);

    return (
        <View>
            <View className="flex-row items-center mb-4 gap-3">
                <Ionicons name="alert-circle" size={32} color={theme.colors.error} />
                <Text className="text-text text-xl font-bold" style={{ color: theme.colors.error }}>
                    {t('deleteAccount.title') || 'Delete Account'}
                </Text>
            </View>

            <Text className="text-text text-sm leading-5 mb-5">
                {t('deleteAccount.warning') || 'This action cannot be undone. Your account and all associated data will be permanently deleted.'}
            </Text>

            {error && (
                <View
                    className="p-3 rounded-lg mb-4"
                    style={{ backgroundColor: `${theme.colors.error}20` }}
                >
                    <Text className="text-text text-sm text-center" style={{ color: theme.colors.error }}>
                        {error}
                    </Text>
                </View>
            )}

            <View className="mb-4">
                <Text className="text-text-secondary text-[13px] mb-2">
                    {t('deleteAccount.confirmLabel', { username }) || `Type "${username}" to confirm`}
                </Text>
                <TextInput
                    className="text-text bg-bg text-base py-3 px-4 border rounded-lg"
                    style={{
                        borderColor: isValid ? theme.colors.success : theme.colors.border,
                    }}
                    value={confirmUsername}
                    onChangeText={setConfirmUsername}
                    placeholder={username}
                    placeholderTextColor={theme.colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!isDeleting}
                />
            </View>

            <View style={{ gap: 8 }}>
                <Button
                    variant="destructive"
                    onPress={handleDelete}
                    disabled={!isValid || isDeleting}
                    loading={isDeleting}
                >
                    {t('deleteAccount.confirm') || 'Delete Forever'}
                </Button>
                <Button variant="secondary" onPress={handleCancel} disabled={isDeleting}>
                    {t('common.cancel') || 'Cancel'}
                </Button>
            </View>
        </View>
    );
};

/** Options accepted by {@link presentDeleteAccount} (everything but `surface`). */
type PresentDeleteAccountOptions = Omit<DeleteAccountModalProps, 'surface'>;

/**
 * Present the delete-account confirmation on the shared surface stack. Resolves
 * `true` once the account is deleted, `false` if cancelled/dismissed.
 */
export function presentDeleteAccount(options: PresentDeleteAccountOptions): Promise<boolean> {
    return surfaces
        .present<boolean>((surface) => <DeleteAccountModal surface={surface} {...options} />)
        .then((result) => result === true);
}

export default DeleteAccountModal;
