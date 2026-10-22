import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { ActivityIndicator } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';
import { useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { RiArrowDownLine } from '@oxy.so/bloom/icons/RiArrowDownLine';
import { RiArrowUpLine } from '@oxy.so/bloom/icons/RiArrowUpLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiImageAddLine } from '@oxy.so/bloom/icons/RiImageAddLine';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import {
  MutedText,
  Panel,
  Pill,
  SectionHeader,
  SelectField,
  TextInputField,
} from '@/components/apps-inference/ui';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import type { PublisherListing, StoreScreenshot } from '@/hooks/use-store-listing';
import {
  moveScreenshot,
  useAddScreenshot,
  useDeleteScreenshot,
  useReorderScreenshots,
  useStoreCategories,
  useStoreListing,
  useStoreScreenshots,
  useSubmitStoreListing,
  useUnpublishStoreListing,
  useWriteStoreListing,
} from '@/hooks/use-store-listing';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import {
  resolveStoredImageUrl,
  uploadPublicImageFileId,
  validateImageFile,
} from '@/lib/image-upload';

const STATUSES: ReadonlyArray<PublisherListing['status']> = [
  'draft',
  'pending_review',
  'published',
  'rejected',
];

const SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Turn an app name into a plausible first slug, matching the API's rule. */
function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/** A value the API stores as absent, so a cleared field round-trips as cleared. */
function orNull(value: string): string | null {
  return value.trim() || null;
}

/**
 * The application's store page.
 *
 * Editing content and moving the page through review are separate actions here
 * because they are separate calls in the API, and for the same reason: the words
 * are the publisher's, the status is the store's. Saving a correction to a live
 * page therefore leaves it live, which is what the buttons say.
 */
export function StoreSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const canEdit = access.can('app:update');
  const { data: listing, isLoading } = useStoreListing(application._id);
  const { data: categories } = useStoreCategories();

  const writeListing = useWriteStoreListing(application._id);
  const submitListing = useSubmitStoreListing(application._id);
  const unpublishListing = useUnpublishStoreListing(application._id);

  const [slug, setSlug] = useState('');
  const [tagline, setTagline] = useState('');
  const [description, setDescription] = useState('');
  const [categorySlug, setCategorySlug] = useState('');
  const [supportUrl, setSupportUrl] = useState('');
  const [supportEmail, setSupportEmail] = useState('');

  // The form is seeded from the server's answer once it arrives, and re-seeded
  // whenever the row itself changes — which is why the effect keys on the
  // listing's `updatedAt` rather than on the object, and why it is an effect at
  // all: this is external state arriving, not a value derived from props.
  const seededAt = useRef<string | null>(null);
  useEffect(() => {
    if (isLoading) return;
    const stamp = listing?.updatedAt ?? 'none';
    if (seededAt.current === stamp) return;
    seededAt.current = stamp;

    setSlug(listing?.slug ?? slugFromName(application.name));
    setTagline(listing?.tagline ?? '');
    setDescription(listing?.description ?? '');
    setCategorySlug(listing?.category?.slug ?? '');
    setSupportUrl(listing?.supportUrl ?? '');
    setSupportEmail(listing?.supportEmail ?? '');
  }, [isLoading, listing, application.name]);

  if (isLoading) {
    return (
      <View className="items-center py-12">
        <ActivityIndicator />
      </View>
    );
  }

  const handleSave = async () => {
    if (!slug.trim()) {
      toast.error(t('appsStore.slugRequired'));
      return;
    }

    try {
      await writeListing.mutateAsync({
        slug: slug.trim().toLowerCase(),
        tagline: orNull(tagline),
        description: orNull(description),
        categorySlug: orNull(categorySlug),
        supportUrl: orNull(supportUrl),
        supportEmail: orNull(supportEmail),
      });
      toast.success(listing ? t('appsStore.saved') : t('appsStore.createdToast'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('appsStore.saveFailed')));
    }
  };

  const handleSubmit = async () => {
    try {
      await submitListing.mutateAsync();
      toast.success(t('appsStore.submitted'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('appsStore.submitFailed')));
    }
  };

  const handleUnpublish = async () => {
    try {
      await unpublishListing.mutateAsync();
      toast.success(t('appsStore.takenDown'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('appsStore.takeDownFailed')));
    }
  };

  const status = listing?.status;
  const canSubmit = status === 'draft' || status === 'rejected';
  const canUnpublish = status === 'published' || status === 'pending_review';

  return (
    <View className="gap-8">
      <View className="gap-4">
        <View className="flex-row items-start justify-between gap-4">
          <View className="min-w-0 flex-1">
            <Text className="text-lg font-semibold text-foreground">{t('appsStore.title')}</Text>
            <View className="mt-1">
              <MutedText>
                {status ? t(`appsStore.status.${status}.help`) : t('appsStore.notListed')}
              </MutedText>
            </View>
          </View>
          {status && STATUSES.includes(status) && (
            <Pill label={t(`appsStore.status.${status}.label`)} tone="secondary" />
          )}
        </View>

        <View className="gap-4">
          <TextInputField
            label={t('appsStore.fields.slug')}
            value={slug}
            onChange={setSlug}
            placeholder="mention"
            disabled={!canEdit}
            help={t('appsStore.fields.slugHelp')}
          />
          <TextInputField
            label={t('appsStore.fields.tagline')}
            value={tagline}
            onChange={setTagline}
            placeholder={t('appsStore.fields.taglinePlaceholder')}
            maxLength={160}
            disabled={!canEdit}
          />
          <Textarea
            label={t('appsStore.fields.description')}
            value={description}
            onChangeText={setDescription}
            placeholder={t('appsStore.fields.descriptionPlaceholder')}
            rows={8}
            disabled={!canEdit}
          />
          <SelectField
            label={t('appsStore.fields.category')}
            value={categorySlug}
            onChange={setCategorySlug}
            placeholder={t('appsStore.fields.uncategorised')}
            disabled={!canEdit}
            items={(categories ?? []).map((category) => ({
              value: category.slug,
              label: category.label,
            }))}
          />
          <TextInputField
            label={t('appsStore.fields.supportUrl')}
            value={supportUrl}
            onChange={setSupportUrl}
            placeholder="https://example.com/help"
            inputMode="url"
            disabled={!canEdit}
          />
          <TextInputField
            label={t('appsStore.fields.supportEmail')}
            value={supportEmail}
            onChange={setSupportEmail}
            placeholder="help@example.com"
            inputMode="email"
            disabled={!canEdit}
          />
          <MutedText small>{t('appsStore.fields.inheritedNote')}</MutedText>
        </View>

        {canEdit && (
          <View className="flex-row flex-wrap items-center gap-2">
            <Button onPress={handleSave} loading={writeListing.isPending}>
              {listing ? t('common.save') : t('appsStore.create')}
            </Button>
            {canSubmit && (
              <Button appearance="outline" onPress={handleSubmit} loading={submitListing.isPending}>
                {t('appsStore.submit')}
              </Button>
            )}
            {canUnpublish && (
              <Button
                appearance="outline"
                onPress={handleUnpublish}
                loading={unpublishListing.isPending}
              >
                {status === 'published' ? t('appsStore.takeDown') : t('appsStore.withdraw')}
              </Button>
            )}
          </View>
        )}
      </View>

      {listing && <ScreenshotsSection appId={application._id} canEdit={canEdit} />}
    </View>
  );
}

/**
 * The pictures on the page.
 *
 * Reordering sends the whole order rather than "move this one", because that is
 * what the API takes — and it takes it that way so a request cannot half-apply.
 */
function ScreenshotsSection({ appId, canEdit }: { appId: string; canEdit: boolean }) {
  const { t } = useTranslation();
  const { oxyServices } = useAuth();
  const { data: screenshots, isLoading } = useStoreScreenshots(appId);
  const addScreenshot = useAddScreenshot(appId);
  const deleteScreenshot = useDeleteScreenshot(appId);
  const reorderScreenshots = useReorderScreenshots(appId);
  const [isUploading, setIsUploading] = useState(false);

  const handleFile = async (file: File) => {
    const validation = validateImageFile(file);
    if (!validation.ok) {
      toast.error(validation.message);
      return;
    }

    setIsUploading(true);
    try {
      // Upload first, then attach: the store stores a REFERENCE to an asset,
      // and the API refuses a file that is not live, not an image, or not the
      // caller's — so the id has to exist before it can be named.
      const fileId = await uploadPublicImageFileId(oxyServices, file);
      await addScreenshot.mutateAsync({ fileId });
      toast.success(t('appsStore.screenshots.added'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('appsStore.screenshots.addFailed')));
    } finally {
      setIsUploading(false);
    }
  };

  const handlePick = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: SCREENSHOT_TYPES,
      copyToCacheDirectory: false,
    });
    const file = result.canceled ? undefined : result.assets[0]?.file;
    if (file) await handleFile(file);
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
    <View className="gap-4 border-t border-border pt-8">
      <SectionHeader
        title={t('appsStore.screenshots.title')}
        description={t('appsStore.screenshots.description')}
      />

      {isLoading ? (
        <ActivityIndicator />
      ) : shots.length === 0 ? (
        <MutedText>{t('appsStore.screenshots.empty')}</MutedText>
      ) : (
        <View className="gap-2">
          {shots.map((screenshot, index) => (
            <Panel key={screenshot.id} className="flex-row items-center gap-3 p-2">
              <Image
                source={{ uri: resolveStoredImageUrl(oxyServices, screenshot.fileId) }}
                accessibilityLabel={screenshot.caption ?? ''}
                contentFit="cover"
                className="h-16 w-24 rounded bg-muted"
              />
              <View className="min-w-0 flex-1">
                <Text className="text-sm text-foreground" numberOfLines={1}>
                  {screenshot.caption || t('appsStore.screenshots.noCaption')}
                </Text>
                <MutedText small>{screenshot.platform}</MutedText>
              </View>
              {canEdit && (
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
              )}
            </Panel>
          ))}
        </View>
      )}

      {canEdit && (
        <View className="flex-row">
          <Button
            appearance="outline"
            icon={RiImageAddLine}
            onPress={handlePick}
            disabled={isUploading || addScreenshot.isPending}
            loading={isUploading}
          >
            {isUploading ? t('appsStore.screenshots.uploading') : t('appsStore.screenshots.add')}
          </Button>
        </View>
      )}
    </View>
  );
}
