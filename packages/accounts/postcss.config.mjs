// Runs Tailwind v4 over global.css during the web (Metro/Expo) build. Without
// this, react-native-css/Expo passes the `@tailwind` / `@utility` / `@theme`
// directives through unprocessed, so NO utility rules (.flex-row, .bg-primary,
// .gap-*, …) are ever generated and every className layout utility used by
// @oxy.so/services' web screens is inert. Mirrors commons/test-app-expo.
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
