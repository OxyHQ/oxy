/**
 * `BloomNativeWindTheme`: Bloom's colour tokens for an app's OWN NativeWind
 * classes on native, for apps still using `className` (removed once the fleet
 * has migrated).
 *
 * Bloom styles without NativeWind and no longer publishes its tokens to
 * react-native-css. An app whose remaining classes read them (`bg-primary`
 * through `@oxy.so/bloom/design-tokens/theme.css`) mounts this once, inside
 * `BloomProvider`, around the app: it writes the theme's tokens into
 * react-native-css's root variables, as Bloom did, and again whenever the theme
 * changes; and it gives every Bloom colour scope a layer
 * (`ColorScopeLayerContext`) that hands the scope's tokens to NativeWind's
 * `VariableContextProvider`, so classes inside a scope follow its palette as
 * they did. The web needs neither (Bloom writes the tokens on the document and
 * on each scope's element), so there it only renders its children.
 *
 *   <BloomProvider …>
 *     <BloomNativeWindTheme>
 *       …
 *     </BloomNativeWindTheme>
 *   </BloomProvider>
 */
const { createElement, useLayoutEffect } = require('react');
const { Platform } = require('react-native');
const { ColorScopeLayerContext, useColorTokens } = require('@oxy.so/bloom/theme');

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

/** A colour scope's subtree under its tokens, as NativeWind's own scoped variables. */
function NativeWindScopeLayer({ vars, children }) {
  const { VariableContextProvider } = require('nativewind');
  return createElement(VariableContextProvider, { value: vars }, children);
}

function BloomNativeWindTheme({ children }) {
  const tokens = useColorTokens();
  const native = Platform.OS !== 'web';
  useLayoutEffect(() => {
    if (native) publish(tokens);
  }, [native, tokens]);
  return createElement(
    ColorScopeLayerContext.Provider,
    { value: native ? NativeWindScopeLayer : null },
    children,
  );
}

module.exports = { BloomNativeWindTheme, NativeWindScopeLayer, tokenName };
