import type { FileMetadata } from '@oxy.so/core';
import { chunkPhotos, PHOTOS_PER_ROW } from '../JustifiedPhotoGrid';

// `chunkPhotos` is the row-building logic the justified photo grid owns (moved
// out of FileManagementScreen's former `createJustifiedRows`). It is pure, so it
// is unit-testable — unlike the grid's intrinsic-dimension measurement, which
// depends on native `Image.getSize`.
const photo = (id: string): FileMetadata => ({
    id,
    filename: `${id}.jpg`,
    contentType: 'image/jpeg',
    length: 1,
    chunkSize: 0,
    uploadDate: '2026-01-01T00:00:00.000Z',
    metadata: {},
    variants: [],
});

const ids = (rows: FileMetadata[][]): string[][] => rows.map((row) => row.map((p) => p.id));

describe('chunkPhotos', () => {
    it('returns no rows for an empty list', () => {
        expect(chunkPhotos([], PHOTOS_PER_ROW)).toEqual([]);
    });

    it('groups photos into full rows of the given size', () => {
        const photos = ['a', 'b', 'c', 'd', 'e', 'f'].map(photo);
        expect(ids(chunkPhotos(photos, PHOTOS_PER_ROW))).toEqual([
            ['a', 'b', 'c'],
            ['d', 'e', 'f'],
        ]);
    });

    it('leaves the final row short when the count is not a multiple of the row size', () => {
        const photos = ['a', 'b', 'c', 'd'].map(photo);
        expect(ids(chunkPhotos(photos, PHOTOS_PER_ROW))).toEqual([
            ['a', 'b', 'c'],
            ['d'],
        ]);
    });

    it('preserves order and never drops or duplicates a photo', () => {
        const photos = Array.from({ length: 10 }, (_, i) => photo(`p${i}`));
        const flat = chunkPhotos(photos, PHOTOS_PER_ROW).flat().map((p) => p.id);
        expect(flat).toEqual(photos.map((p) => p.id));
    });

    it('defaults to a trio per row', () => {
        expect(PHOTOS_PER_ROW).toBe(3);
    });
});
