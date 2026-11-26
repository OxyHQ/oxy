/**
 * React Native's `Text` and `TextInput` on Android and iOS, drawing Bloom's base
 * face, Inter, when the text names no family.
 *
 * React Native draws such a text in the system face and has no setting for
 * another default (Android falls back to `Typeface.DEFAULT`). The old way to set
 * one, `Text.defaultProps`, is gone: React 19 applies `defaultProps` to class
 * components only, and `Text` is a function component. Bloom's and the Bloom
 * language's texts name their family; a raw `<Text>` (the app's, a library's)
 * does not, and drew Roboto or San Francisco.
 *
 * Each host puts the base face FIRST in its style, so an inline `fontFamily`
 * (and every Bloom `Text`) still wins. A text nested in another text inherits
 * its parent's family, as React Native does: the base face goes only on a text
 * with no text ancestor.
 *
 * The real components are imported by their files, which the preset's resolver
 * leaves alone for this module (`../index.js`, `withBaseFontText`).
 *
 * `Inter` mirrors `fontFamilies.sans` in `@oxy.so/bloom/fonts`, the family
 * `BloomThemeProvider` loads on native.
 */
const { createElement, useContext } = require('react');
const RNText = require('react-native/Libraries/Text/Text').default;
const RNTextInput = require('react-native/Libraries/Components/TextInput/TextInput').default;
const TextAncestorContext = require('react-native/Libraries/Text/TextAncestorContext').default;
const { withStatics } = require('./statics');

const BASE_FONT = { fontFamily: 'Inter' };

function BaseFontText(props) {
  if (useContext(TextAncestorContext)) return createElement(RNText, props);
  return createElement(RNText, { ...props, style: [BASE_FONT, props.style] });
}

function BaseFontTextInput(props) {
  return createElement(RNTextInput, { ...props, style: [BASE_FONT, props.style] });
}

module.exports = {
  Text: withStatics(RNText, BaseFontText),
  TextInput: withStatics(RNTextInput, BaseFontTextInput),
};
