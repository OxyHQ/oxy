export interface OxySplashScreenPluginOptions {
  /**
   * Project-relative path to the app's center logo PNG (white/light symbol on
   * transparent, ideally 1024×1024). Required.
   */
  image: string;
  /**
   * Splash icon width in dp. Defaults to 176 (fits the Android 12+ masked-icon
   * safe circle). See the JS doc for why.
   */
  imageWidth?: number;
  /** Splash background color. Defaults to the shared dark Oxy brand `#0B0B0F`. */
  backgroundColor?: string;
  /** Icon resize mode. Defaults to `contain` (never crops). */
  resizeMode?: 'contain' | 'cover' | 'native';
  /** Optional dark-mode logo (defaults to `image`). */
  darkImage?: string;
  /** Optional dark-mode background color (defaults to `backgroundColor`). */
  darkBackgroundColor?: string;
}

export interface ExpoSplashScreenPluginConfig {
  image: string;
  imageWidth: number;
  resizeMode: 'contain' | 'cover' | 'native';
  backgroundColor: string;
  dark: {
    image: string;
    imageWidth: number;
    resizeMode: 'contain' | 'cover' | 'native';
    backgroundColor: string;
  };
}

/**
 * Build the `expo-splash-screen` plugin tuple with Oxy-standard splash defaults.
 * The app passes its own center logo; the Oxy bottom branding is added
 * separately by the `@oxy.so/expo-splash` config plugin.
 */
export function oxySplashScreenPlugin(
  options: OxySplashScreenPluginOptions,
): ['expo-splash-screen', ExpoSplashScreenPluginConfig];
