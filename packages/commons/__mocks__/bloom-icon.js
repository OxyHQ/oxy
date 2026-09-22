/**
 * Stands in for every `@oxy.so/bloom/icons/Ri*` subpath under Jest.
 *
 * The real glyphs render `react-native-svg`, which needs the full React Native
 * runtime; this suite maps `react-native` to a lightweight stub
 * (`__mocks__/react-native.ts`) with no `Touchable`, so importing a single glyph
 * takes a whole suite down at import time. A glyph has no behaviour worth
 * asserting on — it draws one path — so one inert component serves them all.
 *
 * A PROXY rather than a fixed set of exports, because each module exports its
 * own name (`RiCheckLine` from `.../RiCheckLine`) and the app adds glyphs as
 * screens need them. Anything asked of this module answers with the same stub,
 * so a new glyph never needs a matching mock.
 *
 * Plain JS, not TSX: ts-jest compiles a `.tsx` mock to a module whose
 * `__esModule` is a read-only property, and assigning the flag the interop
 * needs then throws at import time.
 */
const React = require('react');

function BloomIconStub() {
  return null;
}
BloomIconStub.displayName = 'BloomIconStub';

module.exports = new Proxy(
  { __esModule: true, default: BloomIconStub },
  {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property === 'symbol') return undefined;
      return BloomIconStub;
    },
  },
);
