module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          // Fix for Expo SDK 54+ Skia import issue
          // ReferenceError: Property 'SkiaViewApi' doesn't exist
          experimentalImportSupport: false,
        },
      ],
    ],
    plugins: [
      // resolver must come first for proper module resolution
      [
        'module-resolver',
        {
          root: ['./'], // Ensure it resolves relative to package root
          alias: { '@': './' },
          extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
        },
      ],
      // react-native-worklets plugin must be listed last for Reanimated v4
      'react-native-worklets/plugin',
    ],
  };
};
