{
  "name": "@{{APP_SLUG}}/frontend",
  "version": "0.1.0",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "start": "expo start",
    "android": "expo start --android",
    "ios": "expo start --ios",
    "web": "expo start --web",
    "export:web": "expo export --platform web",
    "prebuild": "expo prebuild",
    "lint": "expo lint",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@{{APP_SLUG}}/shared-types": "workspace:*",
    "@expo/vector-icons": "{{v.expoVectorIcons}}",
    "@oxyhq/app-preset": "{{v.oxyAppPreset}}",
    "@oxyhq/bloom": "{{v.oxyBloom}}",
    "@oxyhq/core": "{{v.oxyCore}}",
    "@oxyhq/services": "{{v.oxyServices}}",
    "@react-native-async-storage/async-storage": "{{v.asyncStorage}}",
    "@tanstack/query-async-storage-persister": "{{v.queryAsyncStoragePersister}}",
    "@tanstack/react-query": "{{v.reactQuery}}",
    "@tanstack/react-query-persist-client": "{{v.reactQueryPersist}}",
    "expo": "{{v.expo}}",
    "expo-build-properties": "{{v.expoBuildProperties}}",
    "expo-constants": "{{v.expoConstants}}",
    "expo-font": "{{v.expoFont}}",
    "expo-image": "{{v.expoImage}}",
    "expo-linking": "{{v.expoLinking}}",
    "expo-router": "{{v.expoRouter}}",
    "expo-splash-screen": "{{v.expoSplashScreen}}",
    "expo-status-bar": "{{v.expoStatusBar}}",
    "expo-system-ui": "{{v.expoSystemUi}}",
    "expo-web-browser": "{{v.expoWebBrowser}}",
    "expo-haptics": "{{v.expoHaptics}}",
    "expo-image-picker": "{{v.expoImagePicker}}",
    "expo-image-manipulator": "{{v.expoImageManipulator}}",
    "expo-document-picker": "{{v.expoDocumentPicker}}",
    "nativewind": "{{v.nativewind}}",
    "react": "{{v.react}}",
    "react-dom": "{{v.reactDom}}",
    "react-native": "{{v.reactNative}}",
    "react-native-css": "{{v.reactNativeCss}}",
    "react-native-gesture-handler": "{{v.gestureHandler}}",
    "react-native-keyboard-controller": "{{v.keyboardController}}",
    "react-native-qrcode-svg": "{{v.reactNativeQrcodeSvg}}",
    "react-native-reanimated": "{{v.reanimated}}",
    "react-native-safe-area-context": "{{v.safeAreaContext}}",
    "react-native-screens": "{{v.screens}}",
    "react-native-svg": "{{v.svg}}",
    "react-native-web": "{{v.reactNativeWeb}}",
    "react-native-worklets": "{{v.worklets}}",
    "tailwindcss": "{{v.tailwindcss}}"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "{{v.tailwindPostcss}}",
    "@types/react": "{{v.reactTypes}}",
    "@types/react-dom": "{{v.reactDomTypes}}",
    "babel-plugin-module-resolver": "{{v.babelModuleResolver}}",
    "babel-preset-expo": "{{v.babelPresetExpo}}",
    "eslint": "{{v.eslint}}",
    "eslint-config-expo": "{{v.eslintConfigExpo}}",
    "typescript": "{{v.typescript}}"
  },
  "expo": {
    "install": {
      "exclude": [
        "react-native-safe-area-context",
        "react-native-svg"
      ]
    }
  }
}
