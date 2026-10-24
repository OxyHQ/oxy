/**
 * react-native-macos fork of `imageSize.ts`: expo-image has no macOS
 * implementation (see `components/ExpoImage.macos.tsx`), so the size comes
 * from react-native's `Image.getSize`, which react-native-macos answers through
 * NSImage. Fresco, the reason the Android fork avoids it, is Android-only.
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
