/**
 * Placeholder SVG and image utilities
 * Used for missing or deleted files
 */

/**
 * Visible SVG placeholder for missing files
 * Shows a grid pattern with "Missing or deleted" message
 */
export const MISSING_FILE_SVG_PLACEHOLDER = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200" role="img" aria-label="Missing file">
  <defs>
    <pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse">
      <rect width="16" height="16" fill="#f3f4f6"/>
      <path d="M16 0H0V16" fill="none" stroke="#e5e7eb" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#grid)"/>
  <g fill="none" stroke="#9ca3af" stroke-width="3">
    <rect x="8" y="8" width="304" height="184" rx="8"/>
    <path d="M80 140l40-40 30 30 40-50 50 60"/>
    <circle cx="115" cy="88" r="10"/>
  </g>
  <text x="50%" y="50%" text-anchor="middle" fill="#6b7280" font-family="sans-serif" font-size="14" dy="56">Missing or deleted</text>
  <text x="50%" y="50%" text-anchor="middle" fill="#9ca3af" font-family="sans-serif" font-size="12" dy="76">id: {FILE_ID}</text>
</svg>`;

/**
 * Generate SVG placeholder with file ID
 */
export function generateMissingFilePlaceholder(fileId: string): string {
  return MISSING_FILE_SVG_PLACEHOLDER.replace('{FILE_ID}', fileId);
}

/**
 * 1x1 transparent PNG (invisible placeholder)
 * Base64 encoded PNG
 */
export const TRANSPARENT_PNG_PLACEHOLDER =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
