import { createHash } from 'node:crypto';

import { serializeResolvedLinkPreviews } from '../linkPreviewExport';

describe('serializeResolvedLinkPreviews', () => {
  it('sorts records and attests their count and exact bytes', () => {
    const output = serializeResolvedLinkPreviews([
      { id: 'z', requestedUrl: 'https://z.example', canonicalUrl: 'https://z.example', title: null, description: null, siteName: null, favicon: null, imageUrl: null, version: 1, resolvedAt: null, createdAt: new Date('2025-01-01Z'), updatedAt: new Date('2025-01-02Z') },
      { id: 'a', requestedUrl: 'https://a.example', canonicalUrl: 'https://a.example', title: 'A', description: null, siteName: 'A', favicon: null, imageUrl: null, version: 2, resolvedAt: new Date('2025-01-03Z'), createdAt: new Date('2025-01-01Z'), updatedAt: new Date('2025-01-03Z') },
    ]);
    const [manifestLine, ...recordLines] = output.trimEnd().split('\n');
    const manifest = JSON.parse(manifestLine ?? '{}') as { recordCount: number; recordsSha256: string };

    expect(JSON.parse(recordLines[0] ?? '{}')).toMatchObject({ id: 'a', type: 'link_preview' });
    expect(manifest.recordCount).toBe(2);
    expect(manifest.recordsSha256).toBe(createHash('sha256').update(recordLines.map((line) => `${line}\n`).join('')).digest('hex'));
  });

  it('emits a valid empty snapshot', () => {
    const [manifestLine] = serializeResolvedLinkPreviews([]).trimEnd().split('\n');
    expect(JSON.parse(manifestLine ?? '{}')).toMatchObject({ recordCount: 0, version: 1 });
  });
});
