import type React from 'react';
import { useState, useCallback } from 'react';
import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import Ionicons from '../../icons/Ionicons';
import { Button } from '@oxy.so/bloom/button';
import { Field } from '@oxy.so/bloom/field';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { useTheme } from '@oxy.so/bloom/theme';
import { surfaces, type SurfaceControls } from '@oxy.so/bloom/surfaces';
import { createTokenStyles } from '@oxy.so/bloom/theme';

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
  const styles = useStyles();
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
      setError(
        (err instanceof Error ? err.message : null) ||
          t('deleteAccount.error') ||
          'Failed to delete account',
      );
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
      <View style={styles.row}>
        <Ionicons name="alert-circle" size={32} color={theme.colors.error} />
        <Text style={[styles.title, { color: theme.colors.error }]}>
          {t('deleteAccount.title') || 'Delete Account'}
        </Text>
      </View>

      <Text style={styles.text}>
        {t('deleteAccount.warning') ||
          'This action cannot be undone. Your account and all associated data will be permanently deleted.'}
      </Text>

      <View style={styles.section}>
        <Field
          label={t('deleteAccount.confirmLabel', { username }) || `Type "${username}" to confirm`}
          error={error ?? undefined}
        >
          <TextField>
            <TextFieldInput
              label={
                t('deleteAccount.confirmLabel', { username }) || `Type "${username}" to confirm`
              }
              value={confirmUsername}
              onValueChange={(value) => {
                setConfirmUsername(value);
                setError(null);
              }}
              placeholder={username}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isDeleting}
              isInvalid={!!error}
            />
          </TextField>
        </Field>
      </View>

      <View style={{ gap: 8 }}>
        <Button
          appearance="solid"
          tone="danger"
          onPress={handleDelete}
          disabled={!isValid || isDeleting}
          loading={isDeleting}
        >
          {t('deleteAccount.confirm') || 'Delete Forever'}
        </Button>
        <Button appearance="subtle" tone="neutral" onPress={handleCancel} disabled={isDeleting}>
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

const useStyles = createTokenStyles((t) => ({
  row: { marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { fontSize: 20, fontWeight: 700, color: t.foreground, lineHeight: 28 },
  text: { marginBottom: 20, fontSize: 14, lineHeight: 20, color: t.foreground },
  section: { marginBottom: 16 },
}));
