import type { FileRecord } from '../types/file.types';

/** The wire identity of a completed rendition, shared by metadata and the CDN. */
export function readyVariantRevision(
  file: Pick<FileRecord, 'variants'>,
  variant: string,
): string | undefined {
  const readyAt = file.variants?.find((entry) => entry.type === variant && entry.readyAt)?.readyAt;
  return readyAt ? new Date(readyAt).toISOString() : undefined;
}

/** Only canonical UTC timestamps can partition the resolver cache. */
export function isRenditionRevision(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}
