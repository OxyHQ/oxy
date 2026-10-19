/**
 * Intrinsic pixel size of an image the SDK is about to draw, for the layouts
 * that size a box from it (the justified photo grid, the file viewer, the
 * avatar crop stage). Resolves `{ width, height }`; rejects when the image
 * cannot be loaded, exactly as react-native's `Image.getSize` reports through
 * its failure callback.
 *
 * This is the web (and `tsc`/Vite) fork: react-native-web's `getSize` is an
 * `<img>` probe, which needs no CORS headers — expo-image's web `loadAsync`
 * uses `fetch`, which does. The native fork (`imageSize.native.ts`) measures
 * through expo-image, so no SDK image depends on react-native's GIF/WebP
 * decoders on Android and an app may turn them off
 * (`expo-build-properties` `android.gifEnabled`/`webpEnabled: false`).
 */
import { Image } from 'react-native';

export interface ImageSize {
  width: number;
  height: number;
}

export function getImageSize(uri: string): Promise<ImageSize> {
  return new Promise<ImageSize>((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}
