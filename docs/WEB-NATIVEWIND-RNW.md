# NativeWind + React Native Web web builds

Web apps that render `@oxyhq/services` or `@oxyhq/bloom` through Vite and
React Native Web must keep Tailwind utilities unlayered:

```css
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/preflight.css" layer(base);
@import "tailwindcss/utilities.css";
```

Do not replace these imports with `@import "tailwindcss"`. Tailwind v4 then
places utilities inside `@layer utilities`, while React Native Web injects its
base `View` reset outside CSS layers. The unlayered reset wins, so `flex-row`
becomes a column, `bg-*` becomes transparent, and `text-*` falls back to the
browser default even though the class names and CSS rules exist.

Vite consumers must also import `nativewind/theme`, Bloom's design-token CSS,
and scan the built SDK output:

```css
@import "nativewind/theme";
@import "@oxyhq/bloom/design-tokens/theme.css";
@source ".../node_modules/@oxyhq/services/lib/**/*.{js,jsx}";
@source ".../node_modules/@oxyhq/bloom/lib/**/*.{js,jsx}";
```

Expo apps should import `@oxyhq/app-preset/base.css`, which already contains
this contract. Native is unaffected: NativeWind resolves the same classes to
runtime styles there.
