/** The macOS project's resolver: react-native-macos's, under Reanimated's (`resolver.js`). */
const { withWorklets } = require('./resolver');

module.exports = withWorklets(require('react-native-macos/jest/resolver'));
