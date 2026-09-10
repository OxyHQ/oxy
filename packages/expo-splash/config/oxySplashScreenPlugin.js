/**
 * `oxySplashScreenPlugin` — build the `expo-splash-screen` plugin tuple with the
 * Oxy-standard splash defaults, so every Oxy Expo app centers ITS OWN logo on
 * the shared dark brand background with consistent sizing.
 *
 * Usage in an app's `app.config.js` (CommonJS):
 *
 *   const { oxySplashScreenPlugin } = require('@oxy.so/expo-splash/config');
 *
 *   plugins: [
 *     'expo-router',
 *     oxySplashScreenPlugin({ image: './assets/images/splash-logo.png' }),
 *     '@oxy.so/expo-splash', // Oxy bottom branding — MUST come after the line above
 *   ]
 *
 * Returns the `['expo-splash-screen', { ... }]` tuple. The app passes its own
 * center logo; the Oxy "from Oxy" bottom mark is added separately by the
 * `@oxy.so/expo-splash` config plugin (`app.plugin.js`).
 *
 * DEFAULTS (verified on-device):
 *   - imageWidth 176: Android 12+ masks the splash icon to a CIRCLE — the 240dp
 *     icon window shows only its inner ~2/3 (~160dp diameter). A 1024×1024 logo
 *     with the symbol occupying ~55% renders ~90–100dp at width 176, comfortably
 *     inside that safe circle. Larger widths (e.g. 320) push the mark past the
 *     circle and the OS clips it. Keep 176 unless the app's logo geometry differs.
 *   - backgroundColor '#0B0B0F': the shared dark Oxy brand background. A white
 *     background makes a white/light logo appear "not to load"; the dark bg also
 *     matches the light Oxy bottom branding.
 *   - resizeMode 'contain': never crop the logo.
 *   - dark variant mirrors the light one so the splash is identical in both OS
 *     appearance modes (the brand background is dark either way).
 *
 * @param {Object} options
 * @param {string} options.image        Project-relative path to the app's center
 *                                       logo PNG (white/light symbol on transparent,
 *                                       ideally 1024×1024). Required.
 * @param {number} [options.imageWidth=176]        Splash icon width in dp.
 * @param {string} [options.backgroundColor='#0B0B0F'] Splash background color.
 * @param {'contain'|'cover'|'native'} [options.resizeMode='contain'] Icon resize mode.
 * @param {string} [options.darkImage]   Optional dark-mode logo (defaults to `image`).
 * @param {string} [options.darkBackgroundColor] Optional dark-mode bg (defaults to `backgroundColor`).
 * @returns {[string, object]} The `expo-splash-screen` plugin tuple.
 */
function oxySplashScreenPlugin(options) {
  if (!options || !options.image) {
    throw new Error(
      'oxySplashScreenPlugin: `image` is required (project-relative path to the ' +
        "app's center logo PNG).",
    );
  }

  const imageWidth =
    typeof options.imageWidth === 'number' ? options.imageWidth : 176;
  const backgroundColor = options.backgroundColor || '#0B0B0F';
  const resizeMode = options.resizeMode || 'contain';
  const darkImage = options.darkImage || options.image;
  const darkBackgroundColor = options.darkBackgroundColor || backgroundColor;

  return [
    'expo-splash-screen',
    {
      image: options.image,
      imageWidth,
      resizeMode,
      backgroundColor,
      dark: {
        image: darkImage,
        imageWidth,
        resizeMode,
        backgroundColor: darkBackgroundColor,
      },
    },
  ];
}

module.exports = { oxySplashScreenPlugin };
