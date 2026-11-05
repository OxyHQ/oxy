/**
 * The image every SDK surface draws with: expo-image's `Image` (Glide on
 * Android, SDWebImage on iOS, an `<img>` on web), never react-native's
 * (`__tests__/packaging/rnImageBoundary.test.ts`).
 *
 * Its one fork, `ExpoImage.macos.tsx`, exists because expo-image has no macOS
 * implementation: its module calls `requireNativeModule('ExpoImage')` when it
 * is first imported, so on react-native-macos merely importing this file's
 * target would throw and take the whole SDK down with it.
 */
export { Image as ExpoImage } from 'expo-image';
