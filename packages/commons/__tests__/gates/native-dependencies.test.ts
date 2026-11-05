/**
 * Expo's dependency-based autolinking links a package's NON-optional peers and
 * skips its optional ones. Every native module Commons reaches through an
 * optional peer of an Oxy package must therefore be a DIRECT dependency here,
 * or the release ships without it and the feature fails at runtime with no
 * build error. Measured: ExpoCrypto was missing from Allo's Android release;
 * ExponentImagePicker and ExpoClipboard were missing from Commons 1.2.0 (the
 * account surface's photo picker and copy buttons).
 */
import pkg from '../../package.json';

const REQUIRED: Record<string, string> = {
  'expo-crypto': "@oxy.so/core's CSPRNG (optional peer of core and protocol)",
  'expo-secure-store': 'the identity key slots (optional peer of core and protocol)',
  '@react-native-async-storage/async-storage': 'the identity marker and flags (optional peer)',
  'expo-image-picker': "the SDK account surface's profile picture (optional peer of services)",
  'expo-clipboard': "the SDK's copy buttons (optional peer of services)",
  'expo-image-manipulator': 'the avatar crop (optional peer of services)',
  'expo-document-picker': 'file pickers in the SDK surfaces (optional peer of services)',
  'expo-notifications': 'sign-in request pushes (optional peer of services)',
  'expo-web-browser': 'OAuth and legal links (optional peer of services)',
  'expo-constants': 'the EAS project id for push (optional peer of services)',
  'expo-haptics': 'SDK haptics (optional peer of services)',
  'expo-linear-gradient': 'SDK surfaces (optional peer of services)',
};

describe('native dependencies Commons needs at runtime', () => {
  const dependencies = pkg.dependencies as Record<string, string>;

  it.each(Object.entries(REQUIRED))('%s is a direct dependency: %s', (name) => {
    expect(dependencies[name]).toBeDefined();
  });
});
