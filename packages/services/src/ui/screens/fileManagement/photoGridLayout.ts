/**
 * Column / tile geometry for the "Choose photo" grid.
 *
 * CRITICAL: the grid MUST size its tiles from the width of the bottom-sheet
 * container it actually renders in — NOT the device screen. On wide viewports
 * the sheet is centered and narrower than the screen (Bloom `<Dialog>` centers
 * on `md+`), so deriving columns/tiles from `Dimensions.get('window').width`
 * (or `useWindowDimensions`) overflows / mis-sizes the tiles. The caller
 * therefore measures the grid container (`onLayout` on a `style`-only wrapper —
 * RN-Web does not fire `onLayout` for `className`'d nodes) and passes that
 * measured width here.
 *
 * Pure and side-effect free so it is unit-testable in Jest (which cannot catch
 * layout bugs in the rendered tree).
 */

/** Inter-tile gutter, in px. Apple Photos-style hairline gap. */
export const PHOTO_GRID_GUTTER = 2;

/** Container width (px) at/above which the grid switches to 4 columns. */
export const PHOTO_GRID_WIDE_BREAKPOINT = 600;

export interface PhotoGridLayout {
  /** Number of columns for the current container width. */
  columns: number;
  /**
   * Square tile edge in px. Floored so a full row (columns tiles + gutters)
   * never exceeds the container width.
   */
  cellSize: number;
  /** Inter-tile gutter used to derive `cellSize`. */
  gutter: number;
}

/**
 * Derive the column count + square tile size from the measured grid-container
 * width. Returns `cellSize: 0` for a not-yet-measured (`<= 0`) width so callers
 * can gate rendering until a real measurement arrives.
 */
export function computePhotoGridLayout(containerWidth: number): PhotoGridLayout {
  const columns = containerWidth >= PHOTO_GRID_WIDE_BREAKPOINT ? 4 : 3;
  const usable = containerWidth - PHOTO_GRID_GUTTER * (columns - 1);
  const cellSize = usable > 0 ? Math.floor(usable / columns) : 0;
  return { columns, cellSize, gutter: PHOTO_GRID_GUTTER };
}
