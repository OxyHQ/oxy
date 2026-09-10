import React, { useMemo, useState, useCallback } from 'react';
import { View, Text, Image, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { FileMetadata } from '@oxy.so/core';

type PhotoSize = { width: number; height: number };

/** Stable empty map so an unresolved query yields a referentially-stable value. */
const EMPTY_DIMENSIONS: Record<string, PhotoSize> = {};

/**
 * Measure the intrinsic size of every photo whose thumbnail URL has resolved,
 * via `Image.getSize`. Pure/async (no React state) so it can be a React Query
 * `queryFn`. Photos without a resolved URL are skipped and re-measured on the
 * next signature change; a load error falls back to 1×1 (→ the 4/3 default).
 */
async function measurePhotoDimensions(
    photos: FileMetadata[],
    getThumbUrl: (photo: FileMetadata) => string | undefined,
): Promise<Record<string, PhotoSize>> {
    const measured: Record<string, PhotoSize> = {};
    await Promise.all(
        photos.map(
            (photo) =>
                new Promise<void>((resolve) => {
                    const url = getThumbUrl(photo);
                    if (!url) {
                        resolve();
                        return;
                    }
                    Image.getSize(
                        url,
                        (width, height) => {
                            measured[photo.id] = { width, height };
                            resolve();
                        },
                        () => {
                            measured[photo.id] = { width: 1, height: 1 };
                            resolve();
                        },
                    );
                }),
        ),
    );
    return measured;
}

/** Fixed photos-per-row for the justified grid (Apple Photos-style trio). */
export const PHOTOS_PER_ROW = 3;

/** Chunk a photo list into fixed-length rows (last row may be short). */
export function chunkPhotos(photos: FileMetadata[], perRow: number): FileMetadata[][] {
    const rows: FileMetadata[][] = [];
    for (let i = 0; i < photos.length; i += perRow) {
        rows.push(photos.slice(i, i + perRow));
    }
    return rows;
}

export interface JustifiedPhotoGridProps {
    photos: FileMetadata[];
    /**
     * Resolve a private-safe thumbnail URL for a photo (or `undefined` while the
     * URL is still resolving). The grid measures each photo's intrinsic size from
     * this URL and re-measures automatically once a pending URL resolves.
     */
    getThumbUrl: (photo: FileMetadata) => string | undefined;
    renderJustifiedPhotoItem: (photo: FileMetadata, width: number, height: number, isLast: boolean) => React.ReactElement;
    textColor: string;
    /**
     * Full available width from parent. If omitted, component will measure itself and adapt responsively.
     */
    containerWidth?: number; // optional; will auto-measure if not provided
    gap?: number;
    minRowHeight?: number;
    maxRowHeight?: number;
    dateFormatLocale?: string;
}

/**
 * Responsive justified photo grid that stretches to the provided containerWidth.
 * Uses flex rows with proportional children widths instead of absolute pixel widths so it always fills.
 *
 * Owns its own intrinsic-dimension measurement: it calls `Image.getSize` on each
 * photo's resolved thumbnail URL and reflows once real aspect ratios are known
 * (falling back to 4/3 until then). Measurement re-runs whenever a photo is added
 * OR its (asynchronously-resolved) private-safe URL first appears.
 */
const JustifiedPhotoGrid: React.FC<JustifiedPhotoGridProps> = ({
    photos,
    getThumbUrl,
    renderJustifiedPhotoItem,
    textColor,
    containerWidth: explicitWidth,
    gap = 4,
    minRowHeight = 100,
    maxRowHeight = 300,
    dateFormatLocale = 'en-US',
}) => {
    // Responsive width measurement if not explicitly provided. Never gate the
    // whole grid on measurement — onLayout is unreliable on web (same class of
    // bug fixed in PhotoPickerSection). Fall back to window width until measured.
    const { width: windowWidth } = useWindowDimensions();
    const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
    const resolvedExplicitWidth =
        explicitWidth != null && explicitWidth > 0 ? explicitWidth : null;
    const resolvedMeasuredWidth =
        measuredWidth != null && measuredWidth > 0 ? measuredWidth : null;
    const effectiveWidth = resolvedExplicitWidth ?? resolvedMeasuredWidth ?? windowWidth;

    const onLayoutContainer = useCallback((e: LayoutChangeEvent) => {
        if (resolvedExplicitWidth != null) return; // ignore if controlled
        const w = e.nativeEvent.layout.width;
        setMeasuredWidth(prev => (prev === w ? prev : w));
    }, [resolvedExplicitWidth]);

    // Signature of every photo id + its currently-resolved URL — the measurement
    // query key. A private tile's URL resolves asynchronously after it enters the
    // list, so keying on THIS (not just the photo set) re-measures the moment a
    // URL lands, not just when photos are added.
    const urlSignature = useMemo(
        () => photos.map((p) => `${p.id}:${getThumbUrl(p) ?? ''}`).join('|'),
        [photos, getThumbUrl],
    );

    // Intrinsic dimensions via React Query (no effect): re-runs when the signature
    // changes and reflows the justified rows. `keepPreviousData` holds the last
    // measured map during a re-measure so tiles never flash back to the 4/3 default.
    const dimensionsQuery = useQuery({
        queryKey: ['justifiedPhotoDimensions', urlSignature],
        queryFn: () => measurePhotoDimensions(photos, getThumbUrl),
        placeholderData: keepPreviousData,
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: 5 * 60 * 1000,
    });
    const photoDimensions = dimensionsQuery.data ?? EMPTY_DIMENSIONS;

    // Group photos by date first
    const photosByDate = useMemo(() => {
        return photos.reduce((groups: { [key: string]: FileMetadata[] }, photo) => {
            const date = new Date(photo.uploadDate).toDateString();
            if (!groups[date]) groups[date] = [];
            groups[date].push(photo);
            return groups;
        }, {} as { [key: string]: FileMetadata[] });
    }, [photos]);

    const sortedDates = useMemo(() => Object.keys(photosByDate).sort((a, b) => new Date(b).getTime() - new Date(a).getTime()), [photosByDate]);

    // Track measured width of each date section (may differ if parent applies horizontal padding/margins)
    const [dateWidths, setDateWidths] = useState<Record<string, number>>({});
    const onLayoutDate = useCallback((date: string, width: number) => {
        setDateWidths(prev => (prev[date] === width ? prev : { ...prev, [date]: width }));
    }, []);

    return (
        <View style={{ width: '100%' }} onLayout={onLayoutContainer}>
            {sortedDates.map((date: string) => {
                const dayPhotos = photosByDate[date];
                // Fall back to the overall width until this section is measured.
                const dateWidth = dateWidths[date] ?? effectiveWidth;
                const rows = dateWidth > 0 ? chunkPhotos(dayPhotos, PHOTOS_PER_ROW) : [];
                return (
                    <View
                        key={date}
                        style={{ marginBottom: 24, width: '100%' }}
                        onLayout={e => onLayoutDate(date, e.nativeEvent.layout.width)}
                    >
                        <Text style={{ fontSize: 14, fontWeight: '600', marginBottom: 12, color: textColor }}>
                            {new Date(date).toLocaleDateString(dateFormatLocale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                        </Text>
                        <View style={{ width: '100%' }}>
                            {rows.map((row, rowIndex) => {
                                // Total aspect ratio of the row, using measured dims (fallback 4/3).
                                const aspects = row.map(p => {
                                    const dims = photoDimensions[p.id];
                                    return dims ? dims.width / dims.height : 4 / 3;
                                });
                                const totalAspect = aspects.reduce((a, b) => a + b, 0);
                                const gapsTotal = gap * (row.length - 1);
                                const availableWidth = dateWidth - gapsTotal;
                                // Ideal height that perfectly fills width when preserving aspect ratios.
                                const idealHeight = availableWidth / totalAspect;
                                // Clamp to min/max, then distribute the leftover/overflow proportionally.
                                let rowHeight = idealHeight;
                                let widthAdjustment = 0;
                                if (idealHeight < minRowHeight) {
                                    rowHeight = minRowHeight;
                                    widthAdjustment = availableWidth - rowHeight * totalAspect;
                                } else if (idealHeight > maxRowHeight) {
                                    rowHeight = maxRowHeight;
                                    widthAdjustment = availableWidth - rowHeight * totalAspect;
                                }

                                let widths = aspects.map(ar => ar * rowHeight);
                                if (widthAdjustment !== 0) {
                                    const widthSum = widths.reduce((a, b) => a + b, 0);
                                    widths = widths.map(w => w + (w / widthSum) * widthAdjustment);
                                }

                                // Correct any rounding drift on the last tile so the row fills exactly.
                                const widthSumRounded = widths.reduce((a, b) => a + b, 0);
                                const roundingDiff = availableWidth - widthSumRounded;
                                if (Math.abs(roundingDiff) > 0.5) {
                                    widths[widths.length - 1] += roundingDiff;
                                }

                                return (
                                    <View key={row[0]?.id ?? rowIndex} style={{ flexDirection: 'row', width: '100%', marginBottom: 4 }}>
                                        {row.map((p, i) => {
                                            const photoWidth = widths[i];
                                            return (
                                                <View
                                                    key={p.id}
                                                    style={{ width: photoWidth, height: rowHeight, marginRight: i === row.length - 1 ? 0 : gap }}
                                                >
                                                    {renderJustifiedPhotoItem(p, photoWidth, rowHeight, i === row.length - 1)}
                                                </View>
                                            );
                                        })}
                                    </View>
                                );
                            })}
                        </View>
                    </View>
                );
            })}
        </View>
    );
};

export default React.memo(JustifiedPhotoGrid);
