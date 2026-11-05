/**
 * No image the SDK draws on a device goes through react-native's `Image`.
 *
 * react-native's `Image` (and `Image.getSize`, `ImageBackground`,
 * Reanimated's `Animated.Image`) decode on Android through Fresco, whose GIF
 * and animated-WebP support exists only while `expo-build-properties` keeps
 * `android.gifEnabled`/`webpEnabled` on. The file viewer, the photo grid, the
 * avatar crop stage and profile link previews show ARBITRARY user images, so
 * one react-native `Image` among them would stop an app that turns the
 * decoders off from rendering (or measuring) a user's GIF or WebP. Every one
 * of them draws with expo-image and measures with `ui/utils/imageSize`, whose
 * web fork alone keeps react-native-web's `getSize` (an `<img>` probe, no CORS).
 *
 * The react-native-macos forks are the other exception: expo-image has no macOS
 * implementation and throws on import there, and Fresco is Android-only, so
 * `ExpoImage.macos.tsx` and `imageSize.macos.ts` draw and measure through
 * react-native's `Image` (`macosBoundary.test.ts`). Metro picks a `.macos` file
 * only for the macOS platform, so no Android bundle can reach them.
 */
import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '../../src');

/** The files allowed to name react-native's `Image`: the web measurement fork and the macOS forks. */
const REACT_NATIVE_IMAGE_FORKS = [
  path.join('ui', 'utils', 'imageSize.ts'),
  path.join('ui', 'utils', 'imageSize.macos.ts'),
  path.join('ui', 'components', 'ExpoImage.macos.tsx'),
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** Code only: comments may explain the rule without breaking it. */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every way a file can reach react-native's raster `Image`. */
function namesReactNativeImage(source: string): boolean {
  return (
    /import\s*\{[^}]*\b(Image|ImageBackground)\b[^}]*\}\s*from\s*['"]react-native['"]/.test(
      source,
    ) ||
    /import\s+\*\s+as\s+\w+\s+from\s*['"]react-native['"]/.test(source) ||
    /require\(\s*['"]react-native['"]\s*\)/.test(source) ||
    /\bAnimated\.Image\b/.test(source)
  );
}

describe("react-native's Image boundary", () => {
  const files = sourceFiles(srcRoot);

  it('walks the real source tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('the detector sees every shape it guards', () => {
    expect(namesReactNativeImage("import { View, Image } from 'react-native';")).toBe(true);
    expect(namesReactNativeImage("import {\n  ImageBackground,\n} from 'react-native';")).toBe(
      true,
    );
    expect(namesReactNativeImage('<Animated.Image source={src} />')).toBe(true);
    expect(namesReactNativeImage("import { Image } from 'expo-image';")).toBe(false);
    expect(namesReactNativeImage("import { ImageSourcePropType } from 'react-native';")).toBe(
      false,
    );
  });

  it('names it only in the web measurement fork and the macOS forks', () => {
    for (const fork of REACT_NATIVE_IMAGE_FORKS) {
      expect(namesReactNativeImage(code(path.join(srcRoot, fork)))).toBe(true);
    }
    const offenders = files
      .map((file) => path.relative(srcRoot, file))
      .filter((rel) => !REACT_NATIVE_IMAGE_FORKS.includes(rel))
      .filter((rel) => namesReactNativeImage(code(path.join(srcRoot, rel))));
    expect(offenders).toEqual([]);
  });

  it.each([
    'ui/components/fileManagement/FileViewer.tsx',
    'ui/components/photogrid/JustifiedPhotoGrid.tsx',
    'ui/screens/AvatarCropScreen.tsx',
  ])('%s measures through getImageSize', (rel) => {
    const source = code(path.join(srcRoot, rel));
    expect(namesReactNativeImage(source)).toBe(false);
    expect(source).toMatch(
      /import\s*\{\s*getImageSize\s*\}\s*from\s*['"][./]+\/utils\/imageSize['"]/,
    );
    expect(source).not.toMatch(/\bgetSize\(/);
  });

  it('the native measurement fork goes through expo-image', () => {
    const native = code(path.join(srcRoot, 'ui/utils/imageSize.native.ts'));
    expect(native).toMatch(/from\s*['"]expo-image['"]/);
    expect(native).not.toMatch(/['"]react-native['"]/);
  });
});
