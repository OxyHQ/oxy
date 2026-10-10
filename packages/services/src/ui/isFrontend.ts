// Utility to detect if running in a frontend (browser or React Native) environment
const isFrontend =
  typeof window !== 'undefined' ||
  (typeof navigator !== 'undefined' && navigator.product === 'ReactNative');

export default isFrontend;
