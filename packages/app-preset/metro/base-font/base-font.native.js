/**
 * NativeWind's `Text` and `TextInput` on Android and iOS, drawing Bloom's base
 * face, Inter, when the text names no family.
 *
 * React Native draws such a text in the system face and has no setting for
 * another default (Android falls back to `Typeface.DEFAULT`). The old way to set
 * one, `Text.defaultProps`, is gone: React 19 applies `defaultProps` to class
 * components only, and `Text` is a function component. So every text that
 * named no family, a raw `<Text className="text-[15px]">` included, drew Roboto
 * or San Francisco.
 *
 * Each component is `styled(host, mapping)`, as NativeWind builds its own, over
 * a host that puts the base face FIRST in the style it is finally given. Under
 * `styled()` that style is the className's utilities followed by the caller's
 * inline style, so a `font-*` utility, an inline `fontFamily` and every Bloom
 * `Text` (which names its own family) still win. A text nested in another text
 * inherits its parent's family, as React Native does: the base face goes only on
 * a text with no text ancestor.
 *
 * `Inter` mirrors `fontFamilies.sans` in `@oxy.so/bloom/fonts`, the family
 * `BloomThemeProvider` loads on native, as `css/base.css` restates `--font-sans`.
 */
const { createElement, useContext } = require('react');
const { styled } = require('react-native-css');
const { copyComponentProperties } = require('react-native-css/components/copyComponentProperties');
const reactNative = require('react-native');
const MAPPINGS = require('./mappings');

const BASE_FONT = { fontFamily: 'Inter' };

function BaseFontText(props) {
  if (useContext(reactNative.unstable_TextAncestorContext)) {
    return createElement(reactNative.Text, props);
  }
  return createElement(reactNative.Text, { ...props, style: [BASE_FONT, props.style] });
}

function BaseFontTextInput(props) {
  return createElement(reactNative.TextInput, { ...props, style: [BASE_FONT, props.style] });
}

module.exports = {
  Text: copyComponentProperties(reactNative.Text, styled(BaseFontText, MAPPINGS.Text)),
  TextInput: copyComponentProperties(
    reactNative.TextInput,
    styled(BaseFontTextInput, MAPPINGS.TextInput),
  ),
};
