import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@oxyhq/services';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  Image01Icon,
} from '@hugeicons/core-free-icons';
import { toast } from '@oxyhq/bloom/toast';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import type { PublisherListing, StoreScreenshot } from '@/hooks/use-store-listing';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getErrorMessage } from '@/lib/api-error';
import {
  resolveStoredImageUrl,
  uploadPublicImageFileId,
  validateImageFile,
} from '@/lib/image-upload';
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

/** The four states a page can be in, and what each one means to its publisher. */
const STATUS_COPY: Record<PublisherListing['status'], { label: string; help: string }> = {
  draft: {
    label: 'Draft',
    help: 'Only you can see this. Submit it when you want the store to review it.',
  },
  pending_review: {
    label: 'In review',
    help: 'The store is looking at this page. You can withdraw it while it waits.',
  },
  published: {
    label: 'Published',
    help: 'Live on the store. Edits go out immediately; taking it down returns it to a draft.',
  },
  rejected: {
    label: 'Sent back',
    help: 'The store did not publish this. Fix what it asked for and submit it again.',
  },
};

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

interface StoreSectionProps {
  application: Application;
  access: CallerAccess;
}

/**
 * The application's store page.
 *
 * Editing content and moving the page through review are separate actions here
 * because they are separate calls in the API, and for the same reason: the words
 * are the publisher's, the status is the store's. Saving a correction to a live
 * page therefore leaves it live, which is what the buttons say.
 */
export function StoreSection({ application, access }: StoreSectionProps) {
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
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  const handleSave = async () => {
    if (!slug.trim()) {
      toast.error('A store address is required');
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
      toast.success(listing ? 'Store page saved' : 'Store page created');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save the store page'));
    }
  };

  const handleSubmit = async () => {
    try {
      await submitListing.mutateAsync();
      toast.success('Sent to the store for review');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to submit the store page'));
    }
  };

  const handleUnpublish = async () => {
    try {
      await unpublishListing.mutateAsync();
      toast.success('Taken down. It is a draft again.');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to take the page down'));
    }
  };

  const status = listing?.status;
  const canSubmit = status === 'draft' || status === 'rejected';
  const canUnpublish = status === 'published' || status === 'pending_review';

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Store page</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {status
                ? STATUS_COPY[status].help
                : 'This app is not on the store yet. Write its page and submit it.'}
            </p>
          </div>
          {status && <Badge variant="secondary">{STATUS_COPY[status].label}</Badge>}
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="store-slug">Store address</Label>
            <Input
              id="store-slug"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder="mention"
              disabled={!canEdit}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, digits and hyphens. This is what every link to the page carries, so
              changing it after publishing breaks the old address.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="store-tagline">Tagline</Label>
            <Input
              id="store-tagline"
              value={tagline}
              onChange={(event) => setTagline(event.target.value)}
              placeholder="One line, shown whole on the card"
              maxLength={160}
              disabled={!canEdit}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="store-description">Description</Label>
            <Textarea
              id="store-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Markdown. The long text on the page."
              rows={8}
              disabled={!canEdit}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="store-category">Category</Label>
            <Select value={categorySlug} onValueChange={setCategorySlug} disabled={!canEdit}>
              <SelectTrigger id="store-category">
                <SelectValue placeholder="Uncategorised" />
              </SelectTrigger>
              <SelectContent>
                {(categories ?? []).map((category) => (
                  <SelectItem key={category.slug} value={category.slug}>
                    {category.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="store-support-url">Support page</Label>
              <Input
                id="store-support-url"
                value={supportUrl}
                onChange={(event) => setSupportUrl(event.target.value)}
                placeholder="https://example.com/help"
                disabled={!canEdit}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="store-support-email">Support email</Label>
              <Input
                id="store-support-email"
                value={supportEmail}
                onChange={(event) => setSupportEmail(event.target.value)}
                placeholder="help@example.com"
                disabled={!canEdit}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            The name, icon, website and legal links come from this application's settings. The store
            reads them rather than keeping its own copy, so they can never disagree.
          </p>
        </div>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleSave} disabled={writeListing.isPending}>
              {writeListing.isPending ? 'Saving…' : listing ? 'Save' : 'Create store page'}
            </Button>
            {canSubmit && (
              <Button variant="outline" onClick={handleSubmit} disabled={submitListing.isPending}>
                Submit for review
              </Button>
            )}
            {canUnpublish && (
              <Button
                variant="outline"
                onClick={handleUnpublish}
                disabled={unpublishListing.isPending}
              >
                {status === 'published' ? 'Take down' : 'Withdraw'}
              </Button>
            )}
          </div>
        )}
      </section>

      {listing && <ScreenshotsSection appId={application._id} canEdit={canEdit} />}
    </div>
  );
}

interface ScreenshotsSectionProps {
  appId: string;
  canEdit: boolean;
}

/**
 * The pictures on the page.
 *
 * Reordering sends the whole order rather than "move this one", because that is
 * what the API takes — and it takes it that way so a request cannot half-apply.
 */
function ScreenshotsSection({ appId, canEdit }: ScreenshotsSectionProps) {
  const { oxyServices } = useAuth();
  const { data: screenshots, isLoading } = useStoreScreenshots(appId);
  const addScreenshot = useAddScreenshot(appId);
  const deleteScreenshot = useDeleteScreenshot(appId);
  const reorderScreenshots = useReorderScreenshots(appId);
  const fileInput = useRef<HTMLInputElement>(null);
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
      toast.success('Screenshot added');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to add the screenshot'));
    } finally {
      setIsUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const shots = screenshots ?? [];
    const ids = moveScreenshot(shots, index, direction);
    try {
      await reorderScreenshots.mutateAsync(ids);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to reorder the screenshots'));
    }
  };

  const handleDelete = async (screenshot: StoreScreenshot) => {
    try {
      await deleteScreenshot.mutateAsync(screenshot.id);
      toast.success('Screenshot removed');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to remove the screenshot'));
    }
  };

  const shots = screenshots ?? [];

  return (
    <section className="space-y-4 border-t border-border pt-8">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Screenshots</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Shown on the store page in this order.
        </p>
      </div>

      {isLoading ? (
        <Spinner />
      ) : shots.length === 0 ? (
        <p className="text-sm text-muted-foreground">No screenshots yet.</p>
      ) : (
        <ul className="space-y-2">
          {shots.map((screenshot, index) => (
            <li
              key={screenshot.id}
              className="flex items-center gap-3 rounded-lg border border-border p-2"
            >
              <img
                src={resolveStoredImageUrl(oxyServices, screenshot.fileId)}
                alt={screenshot.caption ?? ''}
                className="h-16 w-24 rounded object-cover bg-muted"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground truncate">
                  {screenshot.caption || 'No caption'}
                </p>
                <p className="text-xs text-muted-foreground">{screenshot.platform}</p>
              </div>
              {canEdit && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move up"
                    disabled={index === 0 || reorderScreenshots.isPending}
                    onClick={() => handleMove(index, -1)}
                  >
                    <HugeiconsIcon icon={ArrowUp01Icon} size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move down"
                    disabled={index === shots.length - 1 || reorderScreenshots.isPending}
                    onClick={() => handleMove(index, 1)}
                  >
                    <HugeiconsIcon icon={ArrowDown01Icon} size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove screenshot"
                    disabled={deleteScreenshot.isPending}
                    onClick={() => handleDelete(screenshot)}
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={16} />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <Button
            variant="outline"
            onClick={() => fileInput.current?.click()}
            disabled={isUploading || addScreenshot.isPending}
          >
            <HugeiconsIcon icon={Image01Icon} size={16} />
            {isUploading ? 'Uploading…' : 'Add screenshot'}
          </Button>
        </div>
      )}
    </section>
  );
}
