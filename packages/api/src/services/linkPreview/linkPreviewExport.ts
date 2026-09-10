import { createHash } from 'node:crypto';

export interface ExportableLinkPreview {
  id: string;
  requestedUrl: string;
  canonicalUrl: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  favicon: string | null;
  imageUrl: string | null;
  version: number;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function serializeResolvedLinkPreviews(rows: readonly ExportableLinkPreview[]): string {
  const recordLines = [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => JSON.stringify({
      type: 'link_preview',
      id: row.id,
      requestedUrl: row.requestedUrl,
      canonicalUrl: row.canonicalUrl,
      title: row.title,
      description: row.description,
      siteName: row.siteName,
      faviconUrl: row.favicon,
      imageUrl: row.imageUrl,
      resolverVersion: row.version,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  const recordsSha256 = createHash('sha256')
    .update(recordLines.map((line) => `${line}\n`).join(''))
    .digest('hex');
  const manifest = JSON.stringify({
    type: 'manifest',
    format: 'oxy-link-previews',
    version: 1,
    recordCount: recordLines.length,
    recordsSha256,
  });
  return `${manifest}\n${recordLines.map((line) => `${line}\n`).join('')}`;
}
