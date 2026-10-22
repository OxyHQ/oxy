import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
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
 * Upload-only avatar widget (Google-Cloud-Console style): pick or drop a file,
 * validate it, upload it as a public asset, and surface the resolved URL via
 * `onChange` ('' when removed). No URL paste.
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
  const [isUploading, setIsUploading] = useState(false);
  // Bumped after each upload so the picker resets to its idle state.
  const [pickerKey, setPickerKey] = useState(0);

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
    } catch (error) {
      onError(
        error instanceof Error && error.message
          ? error.message
          : t('settingsPage.general.avatarUploadFailed'),
      );
    } finally {
      setIsUploading(false);
      setPickerKey((key) => key + 1);
    }
  };

  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-3">
        <Avatar
          size={56}
          uri={resolveStoredImageUrl(oxyServices, value)}
          initials={initials}
          alt={label}
        />
        {value ? (
          <Button
            appearance="plain"
            size="sm"
            disabled={disabled || isUploading}
            onPress={() => onChange('')}
          >
            {t('settingsPage.general.removeAvatar')}
          </Button>
        ) : null}
      </View>
      <FileUpload
        key={pickerKey}
        accessibilityLabel={label}
        allowedExtensions={IMAGE_EXTENSIONS}
        maxBytes={MAX_IMAGE_UPLOAD_BYTES}
        disabled={disabled || isUploading}
        onFileSelected={(file) => void processFile(file)}
        onReject={(message) => onError(message)}
      />
    </View>
  );
}
