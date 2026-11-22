/**
 * `BloomNativeWindTheme`: Bloom's colour tokens for an app's OWN NativeWind
 * classes on native, for apps still using `className` (removed once the fleet
 * has migrated).
 *
 * Bloom styles without NativeWind and no longer publishes its tokens to
 * react-native-css. An app whose remaining classes read them (`bg-primary`
 * through `@oxy.so/bloom/design-tokens/theme.css`) mounts this once, inside
 * `BloomProvider`: it writes the theme's tokens into react-native-css's root
 * variables, as Bloom did, and again whenever the theme changes. The web needs
 * nothing (Bloom writes the same tokens on the document), so it draws nothing
 * and publishes nothing there. A colour scope's own palette does not reach an
 * app's classes on native: those read the app theme.
 *
 *   <BloomProvider …>
 *     <BloomNativeWindTheme />
 *     …
 *   </BloomProvider>
 */
const { useLayoutEffect } = require('react');
const { Platform } = require('react-native');
const { useColorTokens } = require('@oxy.so/bloom/theme');

/** `mutedForeground` → `muted-foreground`, `chart1Active` → `chart-1-active`. */
function tokenName(key) {
  return key
    .replace(/([A-Z])/g, '-$1')
    .replace(/(\d+)/g, '-$1')
    .toLowerCase();
}

function publish(tokens) {
  const { rootVariables } = require('react-native-css/native-internal');
  for (const [key, value] of Object.entries(tokens)) {
    rootVariables(tokenName(key)).set([[value]]);
  }
}

function BloomNativeWindTheme() {
  const tokens = useColorTokens();
  useLayoutEffect(() => {
    if (Platform.OS !== 'web') publish(tokens);
  }, [tokens]);
  return null;
}

module.exports = { BloomNativeWindTheme, tokenName };
