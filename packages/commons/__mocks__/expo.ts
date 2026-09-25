/**
 * `expo` stub for the commons Jest env: only the native-module lookup app code
 * uses. `requireOptionalNativeModule` answers from `linkedNativeModules`, so a
 * test can model a binary that does (or does not) link a given native module.
 */
export const linkedNativeModules = new Set<string>();

export const requireOptionalNativeModule = jest.fn((name: string) =>
  linkedNativeModules.has(name) ? {} : null,
);
