// Renders the app icon, Android adaptive-icon layers, splash logo and favicon from
// the source SVGs in assets/images/. Run it with `bun scripts/render-app-icons.mjs`
// from packages/frontend after editing an SVG. It needs `sharp` resolvable, which
// the app does not depend on on purpose (the PNGs are committed; only this script
// needs a rasterizer): `bun add --no-save sharp` first.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sharp = (await import('sharp')).default;
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'images');

// [source svg, output png, pixel size]
const outputs = [
  ['icon.svg', 'icon.png', 1024],
  ['icon_background.svg', 'icon_background.png', 432],
  ['icon_foreground.svg', 'icon_foreground.png', 432],
  // The themed (Android 13+) icon is the white glyph alone; the launcher tints it.
  ['icon_foreground.svg', 'icon_monochrome.png', 432],
  ['splash-logo.svg', 'splash-logo.png', 1024],
  ['favicon.svg', 'favicon.png', 48],
];

for (const [src, out, size] of outputs) {
  await sharp(join(dir, src), { density: 300 }).resize(size, size).png().toFile(join(dir, out));
  console.log(`${out} ${size}x${size}`);
}
