/**
 * Stands in for `react-native-svg` under Jest.
 *
 * The real package reaches deep into React Native at MODULE scope — it
 * destructures `Touchable.Mixin`, calls `processColor`, and pulls in a dozen
 * more surfaces — and this suite maps `react-native` to a small stub. Shimming
 * them one at a time was the first attempt and it was a treadmill: each shim
 * revealed the next import. Mocking the package is one decision instead of
 * twelve, and it is honest about what the suite actually tests — none of these
 * assertions are about SVG output.
 *
 * It arrived with `@oxy.so/bloom/button`, which draws a `CloseButton`.
 *
 * A PROXY so every element the library exports (`Svg`, `Path`, `Circle`,
 * `Defs`, `LinearGradient`, …) answers without a list to maintain.
 */
const React = require('react');

function SvgStub({ children }) {
  return React.createElement(React.Fragment, null, children);
}
SvgStub.displayName = 'SvgStub';

module.exports = new Proxy(
  { __esModule: true, default: SvgStub },
  {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property === 'symbol') return undefined;
      return SvgStub;
    },
  },
);
