/**
 * react-native-macos 0.83's Jest mocks build each component's mock with its `jest/mockComponent`,
 * which reads `RealComponent.prototype.constructor` and so throws on a function component without
 * a prototype (its own `Image`, an arrow function). React Native 0.88's copy
 * (`@react-native/jest-preset`) reads `prototype?.constructor`; the mocks use it here, with each
 * component's path resolved from react-native-macos's `jest` directory, as the mocks name it.
 */
const path = require('node:path');
const mockComponent = require('@react-native/jest-preset/jest/mockComponent').default;

const jestDir = path.join(path.dirname(require.resolve('react-native-macos/package.json')), 'jest');

module.exports = {
  __esModule: true,
  default: (moduleName, ...rest) => mockComponent(path.resolve(jestDir, moduleName), ...rest),
};
