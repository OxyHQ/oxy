/**
 * Native fork of `imageSize.ts`: measures through expo-image (Glide on
 * Android, SDWebImage on iOS), the same pipeline and cache `ExpoImage` draws
 * from. react-native's `Image.getSize` decodes through Fresco, whose GIF and
 * animated-WebP support an Android app ships only while `expo-build-properties`
 * keeps `gifEnabled`/`webpEnabled` on — so this file must never name
 * react-native's `Image` (`__tests__/packaging/rnImageBoundary.test.ts`).
 */
import { Image as ExpoImage } from 'expo-image';

export interface ImageSize {
  width: number;
  height: number;
}

export async function getImageSize(uri: string): Promise<ImageSize> {
  const ref = await ExpoImage.loadAsync(uri);
  try {
    // `width`/`height` are logical; times `scale` is the pixel size
    // `Image.getSize` reports, which the callers' layouts were written for.
    const scale = ref.scale > 0 ? ref.scale : 1;
    return { width: ref.width * scale, height: ref.height * scale };
  } finally {
    ref.release();
  }
}
