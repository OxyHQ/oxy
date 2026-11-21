/**
 * NativeWind's own mappings for its `Text` and `TextInput`
 * (`react-native-css/components/Text` and `/TextInput`): a className becomes
 * `style`, and on a TextInput `text-center` and friends also reach `textAlign`.
 */
module.exports = {
  Text: { className: 'style' },
  TextInput: { className: { target: 'style', nativeStyleMapping: { textAlign: true } } },
};
