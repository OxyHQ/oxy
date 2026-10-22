import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { FileUpload, type FileUploadFile } from '@oxy.so/bloom/file-upload';
import type { OxyServices } from '@oxy.so/core';
import { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/lib/i18n';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_UPLOAD_BYTES,
  resolveStoredImageUrl,
  uploadPublicImage,
  validateImageFile,
} from '@/lib/image-upload';

const EXTENSIONS = ALLOWED_IMAGE_MIME_TYPES.map((mime) =>
  mime === 'image/svg+xml' ? 'svg' : mime.replace('image/', ''),
);

/**
 * Upload-only logo widget: validate, upload as a public asset, surface the
 * resolved URL through `onChange`. No URL paste.
 */
export function LogoUploadField({
  oxyServices,
  value,
  name,
  onChange,
  onError,
  disabled = false,
}: {
  oxyServices: OxyServices;
  /** Current image URL (empty string when none). */
  value: string;
  onChange: (url: string) => void;
  onError: (message: string) => void;
  /** Name of the application, for the fallback initial. */
  name: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<FileUploadFile | null>(null);
  const [progress, setProgress] = useState(0);

  const handleSelected = async (picked: FileUploadFile) => {
    const raw = picked.raw;
    if (!(raw instanceof File)) {
      onError(t('applications.general.logoUnsupported'));
      return;
    }
    const validation = validateImageFile(raw);
    if (!validation.ok) {
      onError(validation.message);
      return;
    }
    setFile(picked);
    setProgress(40);
    try {
      const url = await uploadPublicImage(oxyServices, raw);
      setProgress(100);
      onChange(url);
    } catch (error) {
      onError(
        error instanceof Error && error.message
          ? error.message
          : t('applications.general.logoUploadFailed'),
      );
    } finally {
      setFile(null);
      setProgress(0);
    }
  };

  return (
    <View className="flex-row items-start gap-4">
      <Avatar
        size={64}
        name={name}
        source={resolveStoredImageUrl(oxyServices, value, 'full') ?? null}
        alt={t('applications.general.logo')}
      />
      <View className="min-w-0 flex-1 gap-2">
        <FileUpload
          file={file}
          progress={progress}
          disabled={disabled}
          allowedExtensions={EXTENSIONS}
          maxBytes={MAX_IMAGE_UPLOAD_BYTES}
          accessibilityLabel={t('applications.general.logo')}
          onFileSelected={(picked) => void handleSelected(picked)}
          onReject={(message) => onError(message)}
        />
        {value && !disabled ? (
          <View className="flex-row">
            <Button size="sm" appearance="plain" onPress={() => onChange('')}>
              {t('applications.general.logoRemove')}
            </Button>
          </View>
        ) : null}
      </View>
    </View>
  );
}
