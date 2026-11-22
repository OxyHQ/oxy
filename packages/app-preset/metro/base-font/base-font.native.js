/**
 * NativeWind's `Text` and `TextInput` on Android and iOS, over the base-face
 * hosts (`./hosts.native.js`): `styled(host, mapping)`, as NativeWind builds its
 * own. Under `styled()` the host's style is the className's utilities followed by
 * the caller's inline style, so a `font-*` utility, an inline `fontFamily` and
 * every Bloom `Text` (which names its own family) still win.
 */
const { styled } = require('react-native-css');
const { copyComponentProperties } = require('react-native-css/components/copyComponentProperties');
const hosts = require('./hosts');
const MAPPINGS = require('./mappings');

module.exports = {
  Text: copyComponentProperties(hosts.Text, styled(hosts.Text, MAPPINGS.Text)),
  TextInput: copyComponentProperties(hosts.TextInput, styled(hosts.TextInput, MAPPINGS.TextInput)),
};
