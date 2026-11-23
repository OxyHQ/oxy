/**
 * react-native-web's `Text` and `TextInput`, drawing the document's family
 * (Inter: `--font-sans`, `css/base.css`, or the app's own) when the text names
 * none.
 *
 * react-native-web gives a text with no text ancestor, and every TextInput,
 * `font: 14px System`, so it drew the system stack (Segoe UI, Roboto, San
 * Francisco) whatever the page's family. CSS alone cannot undo it: the rule sits
 * in react-native-web's stylesheet at a class's specificity, and anything that
 * beats it there also beats the atomic classes a `fontFamily` style compiles to.
 *
 * Each host puts `fontFamily: inherit` FIRST in its style, as an atomic class
 * (`StyleSheet.create`): it beats react-native-web's default and loses to a
 * later `fontFamily` style (every Bloom `Text` names its own) and to an inline
 * one. A nested text already inherits; inheriting again changes nothing.
 *
 * The hosts are react-native-web's own components, imported by the path that
 * Expo's Babel preset rewrites `import { Text } from 'react-native'` to.
 */
const { createElement } = require('react');
const StyleSheet = require('react-native-web/dist/exports/StyleSheet').default;
const RNWText = require('react-native-web/dist/exports/Text').default;
const RNWTextInput = require('react-native-web/dist/exports/TextInput').default;
const { withStatics } = require('./statics');

const styles = StyleSheet.create({ documentFont: { fontFamily: 'inherit' } });

function DocumentFontText(props) {
  return createElement(RNWText, { ...props, style: [styles.documentFont, props.style] });
}

function DocumentFontTextInput(props) {
  return createElement(RNWTextInput, { ...props, style: [styles.documentFont, props.style] });
}

module.exports = {
  Text: withStatics(RNWText, DocumentFontText),
  TextInput: withStatics(RNWTextInput, DocumentFontTextInput),
};
