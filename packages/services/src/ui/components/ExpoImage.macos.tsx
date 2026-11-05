/**
 * react-native-macos fork of `ExpoImage.tsx`. expo-image ships no macOS
 * podspec, and importing it throws there (`requireNativeModule('ExpoImage')`
 * runs at import), so on macOS the SDK draws with react-native's `Image`,
 * which react-native-macos backs with NSImage. Fresco, the reason the other
 * platforms avoid react-native's `Image`, is Android-only.
 *
 * It accepts expo-image's props, so every call site typechecks once against the
 * default fork, and maps the ones the SDK uses; the rest (transition, cache
 * policy, placeholders) have no macOS equivalent here and are dropped.
 */
import type { ImageContentFit, ImageProps, ImageSource } from 'expo-image';
import { Image, type ImageResizeMode, type ImageSourcePropType } from 'react-native';

const RESIZE_MODE: Record<ImageContentFit, ImageResizeMode> = {
  cover: 'cover',
  contain: 'contain',
  fill: 'stretch',
  none: 'center',
  'scale-down': 'contain',
};

function toImageSource(source: ImageProps['source']): ImageSourcePropType | undefined {
  if (source == null) return undefined;
  if (typeof source === 'number') return source;
  if (typeof source === 'string') return { uri: source };
  if (Array.isArray(source)) return source.length > 0 ? toImageSource(source[0]) : undefined;
  if (typeof source === 'object' && 'uri' in source) {
    const { uri, headers, width, height } = source as ImageSource;
    return { uri, headers, width: width ?? undefined, height: height ?? undefined };
  }
  return undefined;
}

export function ExpoImage({
  source,
  contentFit = 'cover',
  onError,
  style,
  blurRadius,
  accessible,
  accessibilityLabel,
  testID,
  className,
}: ImageProps & { className?: string }) {
  return (
    <Image
      source={toImageSource(source) ?? { uri: '' }}
      resizeMode={RESIZE_MODE[contentFit]}
      onError={onError ? () => onError({ error: 'The image could not be loaded' }) : undefined}
      style={style}
      blurRadius={blurRadius}
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      {...(className ? { className } : null)}
    />
  );
}
