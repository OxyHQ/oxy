/**
 * `expo-modules-core` stub for the jsdom test environment.
 *
 * The real package reaches for the native module registry, which does not exist
 * under jest — and it is imported at module scope by `backgroundSession.ts`, so
 * without this every suite that transitively touches `ui/session` fails to load.
 * Same reason `react-native` and `@oxyhq/bloom` are mapped to mocks here.
 *
 * `requireOptionalNativeModule` returning `null` is also the honest default: it
 * is what the real function returns wherever the module is not linked (web, and
 * any app that does not ship it), so suites that do not care about background
 * credentials exercise the unsupported path. Tests that DO care mock this module
 * themselves with a factory.
 */
export function requireOptionalNativeModule<T>(): T | null {
  return null;
}

export function requireNativeModule<T>(name: string): T {
  throw new Error(`requireNativeModule('${name}') is not available under jest`);
}
