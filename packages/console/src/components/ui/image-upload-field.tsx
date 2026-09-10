import * as React from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Image01Icon, Upload01Icon } from '@hugeicons/core-free-icons';
import type { OxyServices } from '@oxy.so/core';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_UPLOAD_LABEL,
  uploadPublicImage,
  validateImageFile,
} from '@/lib/image-upload';

interface ImageUploadFieldProps {
  /** The `OxyServices` client used to upload and derive the public URL. */
  oxyServices: OxyServices;
  /** Current image URL (empty string when none). */
  value: string;
  /** Called with the resolved public URL on success, or '' when removed. */
  onChange: (url: string) => void;
  /** Disables all interactions (e.g. caller lacks edit permission). */
  disabled?: boolean;
  /** Fallback rendered in the preview tile when `value` is empty. */
  fallback: React.ReactNode;
  /** Called with a user-facing message when validation or upload fails. */
  onError: (message: string) => void;
  /** Accessible label for the upload control. */
  label: string;
}

const ACCEPT_ATTR = ALLOWED_IMAGE_MIME_TYPES.join(',');

/**
 * Upload-only image widget (Google-Cloud-Console style): click or drag-drop a
 * file, validate it, upload as a public asset, and surface the resolved URL via
 * `onChange`. Shows a preview with Replace / Remove affordances. No URL paste.
 */
export function ImageUploadField({
  oxyServices,
  value,
  onChange,
  disabled = false,
  fallback,
  onError,
  label,
}: ImageUploadFieldProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);

  const interactionDisabled = disabled || isUploading;

  const processFile = async (file: File) => {
    const validation = validateImageFile(file);
    if (!validation.ok) {
      onError(validation.message);
      return;
    }
    setIsUploading(true);
    try {
      const url = await uploadPublicImage(oxyServices, file);
      onChange(url);
    } catch (error) {
      onError(error instanceof Error && error.message ? error.message : 'Failed to upload image');
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so selecting the same file again still fires onChange.
    event.target.value = '';
    if (file) {
      void processFile(file);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (interactionDisabled) {
      return;
    }
    const file = event.dataTransfer.files?.[0];
    if (file) {
      void processFile(file);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!interactionDisabled) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const openPicker = () => {
    if (!interactionDisabled) {
      inputRef.current?.click();
    }
  };

  const handleRemove = () => {
    if (!interactionDisabled) {
      onChange('');
    }
  };

  return (
    <div className="flex items-start gap-4">
      {/* Preview / dropzone tile */}
      <div
        role="button"
        tabIndex={interactionDisabled ? -1 : 0}
        aria-label={label}
        aria-disabled={interactionDisabled}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPicker();
          }
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={cn(
          'relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-muted/40 text-muted-foreground transition-colors',
          !interactionDisabled && 'cursor-pointer hover:border-primary/60 hover:bg-muted/60',
          isDragging && 'border-primary bg-primary/5',
          interactionDisabled && 'cursor-not-allowed opacity-60'
        )}
      >
        {value ? (
          <img src={value} alt={label} className="size-full object-cover" />
        ) : (
          fallback
        )}
        {isUploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70">
            <Spinner />
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openPicker}
            disabled={interactionDisabled}
          >
            <HugeiconsIcon icon={value ? Image01Icon : Upload01Icon} size={14} className="mr-1.5" />
            {isUploading ? 'Uploading...' : value ? 'Replace' : 'Upload'}
          </Button>
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              disabled={interactionDisabled}
            >
              Remove
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          PNG, JPEG, SVG, or WebP. Up to {MAX_IMAGE_UPLOAD_LABEL}.
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={handleFileSelected}
        disabled={interactionDisabled}
      />
    </div>
  );
}
