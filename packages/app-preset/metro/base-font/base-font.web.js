/**
 * NativeWind's `Text` and `TextInput` on the web, over the document-font hosts
 * (`./hosts.web.js`): `styled(host, mapping)`, as NativeWind builds its own. A
 * `font-*` utility (the app's stylesheet follows react-native-web's), a later
 * `fontFamily` style and an inline one still win.
 */
const { styled } = require('react-native-css');
const { copyComponentProperties } = require('react-native-css/components/copyComponentProperties');
const hosts = require('./hosts');
const MAPPINGS = require('./mappings');

module.exports = {
  Text: copyComponentProperties(hosts.Text, styled(hosts.Text, MAPPINGS.Text)),
  TextInput: copyComponentProperties(hosts.TextInput, styled(hosts.TextInput, MAPPINGS.TextInput)),
};
