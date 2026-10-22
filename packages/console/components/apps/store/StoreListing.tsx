import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { GroupedSection } from '@oxy.so/bloom/grouped-section';
import { Item } from '@oxy.so/bloom/item';
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
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { ApiState } from '@/components/loading/ApiState';
import { useAppDetail } from '@/components/apps/app-context';
import type { PublisherListing } from '@/hooks/use-store-listing';
import {
  useStoreCategories,
  useStoreListing,
  useSubmitStoreListing,
  useUnpublishStoreListing,
  useWriteStoreListing,
} from '@/hooks/use-store-listing';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { StoreScreenshots } from './StoreScreenshots';

const STATUSES: ReadonlyArray<PublisherListing['status']> = [
  'draft',
  'pending_review',
  'published',
  'rejected',
];

const STATUS_COLOR = {
  draft: 'default',
  pending_review: 'info',
  published: 'success',
  rejected: 'error',
} as const;

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
 * The application's store page: its listing, review state and screenshots.
 *
 * Editing content and moving the page through review are separate actions here
 * because they are separate calls in the API, and for the same reason: the words
 * are the publisher's, the status is the store's. Saving a correction to a live
 * page therefore leaves it live, which is what the buttons say.
 */
export function StoreListing() {
  const { t } = useTranslation();
  const { application, access } = useAppDetail();
  const canEdit = access.can('app:update');
  const {
    data: listing,
    isLoading,
    isError,
    error: loadError,
    refetch,
  } = useStoreListing(application._id);
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
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);

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
    return <Skeleton.Box width="100%" height={320} borderRadius={14} />;
  }

  if (isError) {
    return <ApiState error={loadError} onRetry={() => refetch()} />;
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
      setConfirmUnpublish(false);
      toast.success(t('appsStore.takenDown'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('appsStore.takeDownFailed')));
    }
  };

  const status = listing?.status;
  const canSubmit = status === 'draft' || status === 'rejected';
  const canUnpublish = status === 'published' || status === 'pending_review';

  const categoryItems = (categories ?? []).map((category) => ({
    value: category.slug,
    label: category.label,
  }));

  return (
    <>
      <Item
        title={t('appsStore.title')}
        subtitle={
          <Text className="text-xs text-muted-foreground">
            {status ? t(`appsStore.status.${status}.help`) : t('appsStore.notListed')}
          </Text>
        }
        trailing={
          status && STATUSES.includes(status) ? (
            <Badge
              content={t(`appsStore.status.${status}.label`)}
              variant="subtle"
              color={STATUS_COLOR[status]}
              size="label-small"
            />
          ) : undefined
        }
      />

      <GroupedSection
        title={t('appsStore.sections.listing')}
        footer={t('appsStore.fields.inheritedNote')}
        separator="none"
      >
        <View className="gap-4 p-4">
          <Field
            label={t('appsStore.fields.slug')}
            description={t('appsStore.fields.slugHelp')}
            disabled={!canEdit}
          >
            <TextFieldInput
              label={t('appsStore.fields.slug')}
              value={slug}
              onValueChange={setSlug}
              placeholder="mention"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label={t('appsStore.fields.tagline')} disabled={!canEdit}>
            <TextFieldInput
              label={t('appsStore.fields.tagline')}
              value={tagline}
              onValueChange={setTagline}
              placeholder={t('appsStore.fields.taglinePlaceholder')}
              maxLength={160}
            />
          </Field>
          <Textarea
            label={t('appsStore.fields.description')}
            value={description}
            onChangeText={setDescription}
            placeholder={t('appsStore.fields.descriptionPlaceholder')}
            rows={8}
            disabled={!canEdit}
          />
          <Field label={t('appsStore.fields.category')} disabled={!canEdit}>
            <Select
              value={categorySlug || undefined}
              onValueChange={setCategorySlug}
              disabled={!canEdit}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('appsStore.fields.uncategorised')}>
                  {() =>
                    categoryItems.find((item) => item.value === categorySlug)?.label ??
                    t('appsStore.fields.uncategorised')
                  }
                </SelectValue>
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('appsStore.fields.category')}
                items={categoryItems}
                renderItem={(item) => (
                  <SelectItem value={item.value} label={item.label}>
                    <SelectItemIndicator />
                    <SelectItemText>{item.label}</SelectItemText>
                  </SelectItem>
                )}
              />
            </Select>
          </Field>
        </View>
      </GroupedSection>

      <GroupedSection title={t('appsStore.sections.support')} separator="none">
        <View className="gap-4 p-4">
          <Field label={t('appsStore.fields.supportUrl')} disabled={!canEdit}>
            <TextFieldInput
              label={t('appsStore.fields.supportUrl')}
              value={supportUrl}
              onValueChange={setSupportUrl}
              placeholder="https://example.com/help"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label={t('appsStore.fields.supportEmail')} disabled={!canEdit}>
            <TextFieldInput
              label={t('appsStore.fields.supportEmail')}
              value={supportEmail}
              onValueChange={setSupportEmail}
              placeholder="help@example.com"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        </View>
      </GroupedSection>

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
            <Button appearance="outline" onPress={() => setConfirmUnpublish(true)}>
              {status === 'published' ? t('appsStore.takeDown') : t('appsStore.withdraw')}
            </Button>
          )}
        </View>
      )}

      {listing && <StoreScreenshots appId={application._id} canEdit={canEdit} />}

      <Dialog
        open={confirmUnpublish}
        onClose={() => setConfirmUnpublish(false)}
        title={
          status === 'published'
            ? t('appsStore.confirm.takeDownTitle')
            : t('appsStore.confirm.withdrawTitle')
        }
        description={
          status === 'published'
            ? t('appsStore.confirm.takeDownBody')
            : t('appsStore.confirm.withdrawBody')
        }
        actions={[
          {
            label: status === 'published' ? t('appsStore.takeDown') : t('appsStore.withdraw'),
            color: 'destructive',
            loading: unpublishListing.isPending,
            shouldCloseOnPress: false,
            onPress: handleUnpublish,
          },
          { label: t('common.cancel'), color: 'cancel' },
        ]}
      />
    </>
  );
}
