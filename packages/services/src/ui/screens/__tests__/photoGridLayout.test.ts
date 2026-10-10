import {
  computePhotoGridLayout,
  PHOTO_GRID_GUTTER,
  PHOTO_GRID_WIDE_BREAKPOINT,
} from '../fileManagement/photoGridLayout';

describe('computePhotoGridLayout', () => {
  it('uses 3 columns below the wide breakpoint', () => {
    expect(computePhotoGridLayout(390).columns).toBe(3);
    expect(computePhotoGridLayout(500).columns).toBe(3);
    expect(computePhotoGridLayout(PHOTO_GRID_WIDE_BREAKPOINT - 1).columns).toBe(3);
  });

  it('uses 4 columns at/above the wide breakpoint', () => {
    expect(computePhotoGridLayout(PHOTO_GRID_WIDE_BREAKPOINT).columns).toBe(4);
    expect(computePhotoGridLayout(700).columns).toBe(4);
    expect(computePhotoGridLayout(1024).columns).toBe(4);
  });

  it('floors the tile size so a full row never exceeds the container', () => {
    // The whole point of the bug fix: geometry derives from the passed
    // container width, and a full row of tiles + gutters must fit inside it.
    for (const width of [320, 375, 390, 428, 500, 599, 600, 768, 834, 1024]) {
      const { columns, cellSize, gutter } = computePhotoGridLayout(width);
      const rowWidth = columns * cellSize + (columns - 1) * gutter;
      expect(rowWidth).toBeLessThanOrEqual(width);
      // ...and the floor is tight (adding one px per tile would overflow).
      expect(columns * (cellSize + 1) + (columns - 1) * gutter).toBeGreaterThan(width);
    }
  });

  it('derives smaller tiles from a narrow sheet than from a wide screen', () => {
    // Regression guard for the original bug: a centered dialog (narrow
    // container) must NOT size tiles from a wider screen width.
    const narrowSheet = computePhotoGridLayout(500); // 3 cols
    const wideScreen = computePhotoGridLayout(1200); // 4 cols
    expect(narrowSheet.cellSize).toBeLessThan(wideScreen.cellSize);
    // Cross-check the exact arithmetic against the gutter constant.
    expect(narrowSheet.cellSize).toBe(Math.floor((500 - PHOTO_GRID_GUTTER * 2) / 3));
    expect(wideScreen.cellSize).toBe(Math.floor((1200 - PHOTO_GRID_GUTTER * 3) / 4));
  });

  it('returns cellSize 0 for a not-yet-measured (<= 0) width', () => {
    expect(computePhotoGridLayout(0).cellSize).toBe(0);
    expect(computePhotoGridLayout(-10).cellSize).toBe(0);
    // Columns still resolve to the narrow default so callers can render.
    expect(computePhotoGridLayout(0).columns).toBe(3);
  });

  it('exposes the gutter it used to derive the tile size', () => {
    expect(computePhotoGridLayout(500).gutter).toBe(PHOTO_GRID_GUTTER);
  });
});
