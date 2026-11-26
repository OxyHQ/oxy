// Web-only CSS transition/transform typings for React Native's `ViewStyle`.
//
// On web, React Native for Web forwards these CSS properties straight through to
// the underlying DOM element, so an inline `style={{ transitionProperty: … }}`
// works at runtime — but RN's `ViewStyle` type (which targets native) does not
// declare them, so `tsc` rejects the object literal (TS2322 "Object literal may
// only specify known properties"). Components that reproduce web animations with
// inline transition styles (e.g. `ProfileButton`'s Bluesky-style hover reveal)
// need these keys typed without resorting to `as any`.
//
// This augmentation adds ONLY the standard CSS animation/transition properties
// as optional `string`s. It is guarded at the call site behind `Platform.OS ===
// 'web'`, so native code paths never emit them. The plain `import 'react-native'`
// makes this a module augmentation (merge) rather than a redeclaration. Consumers
// load it via the `/// <reference path>` directives in `src/index.ts` and
// `src/ui/index.ts`.

import 'react-native';

declare module 'react-native' {
  interface ViewStyle {
    transitionProperty?: string;
    transitionDuration?: string;
    transitionDelay?: string;
    transitionTimingFunction?: string;
  }
}
