import { useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { FileUpload, type FileUploadFile } from '@oxy.so/bloom/file-upload';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiArrowDownLine } from '@oxy.so/bloom/icons/RiArrowDownLine';
import { RiArrowUpLine } from '@oxy.so/bloom/icons/RiArrowUpLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import type { StoreScreenshot } from '@/hooks/use-store-listing';
import {
  moveScreenshot,
  useAddScreenshot,
  useDeleteScreenshot,
  useReorderScreenshots,
  useStoreScreenshots,
} from '@/hooks/use-store-listing';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import {
  resolveStoredImageUrl,
  uploadPublicImageFileId,
  validateImageFile,
} from '@/lib/image-upload';

const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * The pictures on the page.
 *
 * Reordering sends the whole order rather than "move this one", because that is
 * what the API takes — and it takes it that way so a request cannot half-apply.
 */
export function StoreScreenshots({ appId, canEdit }: { appId: string; canEdit: boolean }) {
  const { t } = useTranslation();
  const { oxyServices } = useAuth();
  const { data: screenshots, isLoading } = useStoreScreenshots(appId);
  const addScreenshot = useAddScreenshot(appId);
  const deleteScreenshot = useDeleteScreenshot(appId);
  const reorderScreenshots = useReorderScreenshots(appId);
  const [uploading, setUploading] = useState<FileUploadFile | null>(null);

  const handleSelected = async (picked: FileUploadFile) => {
    const raw = picked.raw;
    if (!(raw instanceof File)) {
      toast.error(t('appsStore.screenshots.unsupported'));
      return;
    }
    const validation = validateImageFile(raw);
    if (!validation.ok) {
      toast.error(validation.message);
      return;
    }

    setUploading(picked);
    try {
      // Upload first, then attach: the store stores a REFERENCE to an asset,
      // and the API refuses a file that is not live, not an image, or not the
      // caller's — so the id has to exist before it can be named.
      const fileId = await uploadPublicImageFileId(oxyServices, raw);
      await addScreenshot.mutateAsync({ fileId });
      toast.success(t('appsStore.screenshots.added'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('appsStore.screenshots.addFailed')));
    } finally {
      setUploading(null);
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const ids = moveScreenshot(screenshots ?? [], index, direction);
    try {
      await reorderScreenshots.mutateAsync(ids);
    } catch (error) {
      toast.error(getErrorMessage(error, t('appsStore.screenshots.reorderFailed')));
    }
  };

  const handleDelete = async (screenshot: StoreScreenshot) => {
    try {
      await deleteScreenshot.mutateAsync(screenshot.id);
      toast.success(t('appsStore.screenshots.removed'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('appsStore.screenshots.removeFailed')));
    }
  };

  const shots = screenshots ?? [];

  return (
    <>
      <GroupedSection
        title={t('appsStore.screenshots.title')}
        footer={t('appsStore.screenshots.description')}
        separator="line"
      >
        {isLoading ? (
          <View className="p-4">
            <Skeleton.Box width="100%" height={80} borderRadius={10} />
          </View>
        ) : shots.length === 0 ? (
          <EmptyState
            icon={RiImageLine}
            variant="compact"
            title={t('appsStore.screenshots.empty')}
          />
        ) : (
          shots.map((screenshot, index) => (
            <GroupedSectionItem
              key={screenshot.id}
              title={screenshot.caption || t('appsStore.screenshots.noCaption')}
              description={screenshot.platform}
              icon={
                <Image
                  source={{ uri: resolveStoredImageUrl(oxyServices, screenshot.fileId) }}
                  accessibilityLabel={screenshot.caption ?? ''}
                  contentFit="cover"
                  className="h-16 w-24 rounded bg-muted"
                />
              }
              rightElement={
                canEdit ? (
                  <View className="flex-row items-center gap-1">
                    <Button
                      appearance="plain"
                      size="sm"
                      iconOnly
                      icon={RiArrowUpLine}
                      accessibilityLabel={t('appsStore.screenshots.moveUp')}
                      disabled={index === 0 || reorderScreenshots.isPending}
                      onPress={() => handleMove(index, -1)}
                    />
                    <Button
                      appearance="plain"
                      size="sm"
                      iconOnly
                      icon={RiArrowDownLine}
                      accessibilityLabel={t('appsStore.screenshots.moveDown')}
                      disabled={index === shots.length - 1 || reorderScreenshots.isPending}
                      onPress={() => handleMove(index, 1)}
                    />
                    <Button
                      appearance="plain"
                      size="sm"
                      iconOnly
                      icon={RiDeleteBinLine}
                      accessibilityLabel={t('appsStore.screenshots.remove')}
                      disabled={deleteScreenshot.isPending}
                      onPress={() => handleDelete(screenshot)}
                    />
                  </View>
                ) : undefined
              }
            />
          ))
        )}
      </GroupedSection>

      {canEdit && (
        <FileUpload
          file={uploading}
          progress={uploading ? 50 : 0}
          allowedExtensions={EXTENSIONS}
          maxBytes={MAX_BYTES}
          accessibilityLabel={t('appsStore.screenshots.add')}
          onFileSelected={(picked) => void handleSelected(picked)}
          onReject={(message) => toast.error(message)}
        />
      )}
    </>
  );
}
