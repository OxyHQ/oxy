import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { FileUpload, type FileUploadFile } from '@oxy.so/bloom/file-upload';
import { useAuth } from '@oxy.so/services/ui/client';
import { useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from '@/lib/i18n';
import {
  MAX_IMAGE_UPLOAD_BYTES,
  resolveStoredImageUrl,
  uploadPublicImage,
  validateImageFile,
} from '@/lib/image-upload';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'svg', 'webp'] as const;

/**
 * Avatar row control: the current image, Change (a dialog with Bloom's FileUpload: pick or
 * drop, validate, upload as a public asset) and Remove. `onChange` gets the resolved URL,
 * '' when removed. No URL paste.
 */
export function AccountAvatarField({
  value,
  initials,
  label,
  disabled = false,
  onChange,
  onError,
}: {
  /** Current image URL (empty string when none). */
  value: string;
  initials: string;
  /** Accessible name of the upload control. */
  label: string;
  disabled?: boolean;
  onChange: (url: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const { oxyServices } = useAuth();
  const [open, setOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const processFile = async (picked: FileUploadFile) => {
    const file = picked.raw;
    if (!(file instanceof File)) {
      return;
    }
    const validation = validateImageFile(file);
    if (!validation.ok) {
      onError(validation.message);
      return;
    }
    setIsUploading(true);
    try {
      onChange(await uploadPublicImage(oxyServices, file));
      setOpen(false);
    } catch (error) {
      onError(
        error instanceof Error && error.message
          ? error.message
          : t('settingsPage.general.avatarUploadFailed'),
      );
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <View className="flex-row items-center gap-2">
      <Avatar
        size={40}
        uri={resolveStoredImageUrl(oxyServices, value)}
        initials={initials}
        alt={label}
      />
      <Button
        size="sm"
        appearance="subtle"
        tone="neutral"
        disabled={disabled}
        onPress={() => setOpen(true)}
      >
        {t('settingsPage.general.changeAvatar')}
      </Button>
      {value ? (
        <Button
          size="sm"
          appearance="plain"
          tone="neutral"
          disabled={disabled || isUploading}
          onPress={() => onChange('')}
        >
          {t('settingsPage.general.removeAvatar')}
        </Button>
      ) : null}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('settingsPage.general.accountAvatar')}
        actions={[{ label: t('common.cancel'), color: 'cancel' }]}
      >
        <FileUpload
          accessibilityLabel={label}
          allowedExtensions={IMAGE_EXTENSIONS}
          maxBytes={MAX_IMAGE_UPLOAD_BYTES}
          disabled={isUploading}
          onFileSelected={(file) => void processFile(file)}
          onReject={(message) => onError(message)}
        />
      </Dialog>
    </View>
  );
}
