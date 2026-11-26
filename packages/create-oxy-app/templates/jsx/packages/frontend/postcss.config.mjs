// Runs Tailwind v4 over global.css during the web (Metro/Expo) build. Without
// this, react-native-css/Expo passes the `@tailwind` / `@utility` / `@theme`
// directives through unprocessed, so NO utility rules are generated and every
// className layout utility used on web is inert (react-native-web's base View
// reset shows through). Required alongside the `import '../global.css'` in
// app/_layout.tsx.
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
