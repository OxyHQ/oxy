import React, { useMemo, useState, useCallback } from 'react';
import { View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { skip, useEntities, useList } from '@oxy.so/bloom-data';
import type { FileMetadata } from '@oxy.so/core';
import { PhotoSize, type PhotoToMeasure, photoSizes } from '../../data/files';

type PhotoDimensions = { width: number; height: number };

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
  renderJustifiedPhotoItem: (
    photo: FileMetadata,
    width: number,
    height: number,
    isLast: boolean,
  ) => React.ReactElement;
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
 * Owns its own intrinsic-dimension measurement: it calls `getImageSize` on each
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
  const resolvedExplicitWidth = explicitWidth != null && explicitWidth > 0 ? explicitWidth : null;
  const resolvedMeasuredWidth = measuredWidth != null && measuredWidth > 0 ? measuredWidth : null;
  const effectiveWidth = resolvedExplicitWidth ?? resolvedMeasuredWidth ?? windowWidth;

  const onLayoutContainer = useCallback(
    (e: LayoutChangeEvent) => {
      if (resolvedExplicitWidth != null) return; // ignore if controlled
      const w = e.nativeEvent.layout.width;
      setMeasuredWidth((prev) => (prev === w ? prev : w));
    },
    [resolvedExplicitWidth],
  );

  // Every photo whose (asynchronously resolved, private-safe) URL is known:
  // the measurement read is keyed by these, so a URL that lands later is
  // measured then, not only when photos are added.
  const toMeasure = useMemo(() => {
    const list: PhotoToMeasure[] = [];
    for (const photo of photos) {
      const url = getThumbUrl(photo);
      if (url) list.push({ id: photo.id, url });
    }
    return list;
  }, [photos, getThumbUrl]);

  // Intrinsic sizes (no effect): measured by `photoSizes` and held by photo
  // id, so a size already measured stays on screen while a new set is
  // measured, and tiles never flash back to the 4/3 default.
  useList(photoSizes, ...(toMeasure.length > 0 ? ([toMeasure] as const) : ([skip] as const)));
  const photoIds = useMemo(() => photos.map((photo) => photo.id), [photos]);
  const sizes = useEntities(PhotoSize, photoIds);
  const photoDimensions = useMemo(() => {
    const dimensions: Record<string, PhotoDimensions> = {};
    photoIds.forEach((id, index) => {
      const size = sizes[index];
      if (size) dimensions[id] = { width: size.width, height: size.height };
    });
    return dimensions;
  }, [photoIds, sizes]);

  // Group photos by date first
  const photosByDate = useMemo(() => {
    return photos.reduce(
      (groups: { [key: string]: FileMetadata[] }, photo) => {
        const date = new Date(photo.uploadDate).toDateString();
        if (!groups[date]) groups[date] = [];
        groups[date].push(photo);
        return groups;
      },
      {} as { [key: string]: FileMetadata[] },
    );
  }, [photos]);

  const sortedDates = useMemo(
    () => Object.keys(photosByDate).sort((a, b) => new Date(b).getTime() - new Date(a).getTime()),
    [photosByDate],
  );

  // Track measured width of each date section (may differ if parent applies horizontal padding/margins)
  const [dateWidths, setDateWidths] = useState<Record<string, number>>({});
  const onLayoutDate = useCallback((date: string, width: number) => {
    setDateWidths((prev) => (prev[date] === width ? prev : { ...prev, [date]: width }));
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
            onLayout={(e) => onLayoutDate(date, e.nativeEvent.layout.width)}
          >
            <Text style={{ fontSize: 14, fontWeight: '600', marginBottom: 12, color: textColor }}>
              {new Date(date).toLocaleDateString(dateFormatLocale, {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </Text>
            <View style={{ width: '100%' }}>
              {rows.map((row, rowIndex) => {
                // Total aspect ratio of the row, using measured dims (fallback 4/3).
                const aspects = row.map((p) => {
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

                let widths = aspects.map((ar) => ar * rowHeight);
                if (widthAdjustment !== 0) {
                  const widthSum = widths.reduce((a, b) => a + b, 0);
                  widths = widths.map((w) => w + (w / widthSum) * widthAdjustment);
                }

                // Correct any rounding drift on the last tile so the row fills exactly.
                const widthSumRounded = widths.reduce((a, b) => a + b, 0);
                const roundingDiff = availableWidth - widthSumRounded;
                if (Math.abs(roundingDiff) > 0.5) {
                  widths[widths.length - 1] += roundingDiff;
                }

                return (
                  <View
                    key={row[0]?.id ?? rowIndex}
                    style={{ flexDirection: 'row', width: '100%', marginBottom: 4 }}
                  >
                    {row.map((p, i) => {
                      const photoWidth = widths[i];
                      return (
                        <View
                          key={p.id}
                          style={{
                            width: photoWidth,
                            height: rowHeight,
                            marginRight: i === row.length - 1 ? 0 : gap,
                          }}
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
