// Robust NativeWind className typings for React Native's `ScrollView` & `FlatList`.
//
// NativeWind 5's engine (`react-native-css`) augments `ScrollViewProps` and
// `FlatListProps` with className props, but its declarations carry heritage
// clauses (`interface ScrollViewProps extends ViewProps, ScrollViewPropsIOS, …`)
// and route `FlatList`'s `contentContainerClassName` through a deep
// `@react-native/virtualized-lists` → `ScrollViewProps` augmentation. Under
// React Native 0.85 that heritage no longer matches, and the nested
// `@react-native/virtualized-lists` copy does not resolve from a CONSUMER's
// `node_modules` — so when this package's source is type-checked through the
// `react-native` export condition (which resolves `@oxy.so/services` to raw
// `src/`), those className members silently drop and consumer `tsc` fails with
// TS2769 on screens that use `contentContainerClassName` (e.g.
// ManageAccountScreen, ConnectedAppsScreen).
//
// These heritage-free augmentations add the className props directly to the two
// interfaces, so resolution never depends on the deep virtualized-lists copy or
// on react-native-css's heritage clauses. The plain `import 'react-native'`
// makes this a module so the `declare module` is treated as an augmentation
// (merge) rather than a redeclaration. Consumers load it via the
// `/// <reference path>` directives in `src/index.ts` and `src/ui/index.ts`.

import 'react-native';

declare module 'react-native' {
  interface ScrollViewProps {
    className?: string;
    contentContainerClassName?: string;
    indicatorClassName?: string;
  }

  interface FlatListProps<ItemT> {
    className?: string;
    contentContainerClassName?: string;
    columnWrapperClassName?: string;
    ListHeaderComponentClassName?: string;
    ListFooterComponentClassName?: string;
  }
}
