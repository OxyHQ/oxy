/**
 * Every Oxy Android release is signed with the ecosystem key and FAILS without
 * it; debug builds are untouched. String transforms over Expo SDK 58's generated
 * `android/app/build.gradle` (the fixture is that template, unmodified).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type BuildGradle = { modResults: { language: string; contents: string } };

/** The app/build.gradle mods registered, in order (Expo runs them at prebuild). */
const mockGradleMods: Array<(config: BuildGradle) => BuildGradle> = [];
jest.mock(
  'expo/config-plugins',
  () => ({
    withAndroidManifest: (config: unknown) => config,
    withAppBuildGradle: (config: unknown, action: (c: BuildGradle) => BuildGradle) => {
      mockGradleMods.push(action);
      return config;
    },
  }),
  { virtual: true },
);

const withOxyReleaseSigning = require('../../plugins/withOxyReleaseSigning') as ((
  config: object,
) => object) & {
  applyReleaseSigning: (contents: string) => string;
  ECOSYSTEM_CERT_SHA256: string;
};
const { applyReleaseSigning, ECOSYSTEM_CERT_SHA256 } = withOxyReleaseSigning;

const TEMPLATE = readFileSync(resolve(__dirname, 'fixtures/expo-58-app-build.gradle'), 'utf8');

/** The body of the first `name {` block at `indent` after `from`, up to its closing brace. */
function block(contents: string, header: string, from = 0): string {
  const start = contents.indexOf(header, from);
  expect(start).toBeGreaterThan(-1);
  const indent = header.match(/^\s*/)?.[0] ?? '';
  const end = contents.indexOf(`\n${indent}}`, start);
  return contents.slice(start, end);
}

describe('withOxyReleaseSigning', () => {
  const signed = applyReleaseSigning(TEMPLATE);

  test('the release buildType is always signed by signingConfigs.release, never debug', () => {
    const buildTypes = signed.indexOf('    buildTypes {');
    const release = block(signed, '        release {', buildTypes);
    expect(release).toContain('signingConfig signingConfigs.release');
    expect(release).not.toContain('signingConfigs.debug');
    expect(release).not.toContain('hasProperty');
  });

  test('debug keeps the debug key unless OXY_UPLOAD_SIGN_DEBUG opts in', () => {
    const buildTypes = signed.indexOf('    buildTypes {');
    expect(block(signed, '        debug {', buildTypes)).toContain(
      'signingConfig oxySignDebug ? signingConfigs.release : signingConfigs.debug',
    );
    expect(signed).toContain(
      "def oxySignDebug = (findProperty('OXY_UPLOAD_SIGN_DEBUG') ?: 'false').toString().toBoolean()",
    );
    // The opt-in also puts debug under the guard.
    expect(signed).toContain(
      "def oxySignedBuildTypes = oxySignDebug ? ['release', 'debug'] : ['release']",
    );
    expect(block(signed, '        debug {', signed.indexOf('signingConfigs {'))).toContain(
      "storeFile file('debug.keystore')",
    );
  });

  test('signingConfigs.release reads the keystore resolved from the OXY_UPLOAD_* properties', () => {
    const release = block(signed, '        release {', signed.indexOf('    signingConfigs {'));
    expect(release).toContain('if (oxyUploadSigning) {');
    for (const line of [
      'storeFile oxyStoreFile',
      'storePassword oxyStorePassword',
      'keyAlias oxyKeyAlias',
      'keyPassword oxyKeyPassword',
    ]) {
      expect(release).toContain(line);
    }

    const resolveBlock = signed.slice(0, signed.indexOf('\nandroid {'));
    expect(resolveBlock).toContain("findProperty('OXY_UPLOAD_STORE_FILE')");
    expect(resolveBlock).toContain("oxySigningSecret('OXY_UPLOAD_STORE_PASSWORD')");
    expect(resolveBlock).toContain("findProperty('OXY_UPLOAD_KEY_ALIAS')");
    // A password may come from a file instead (`<name>_FILE`), and the key's
    // defaults to the store's.
    expect(resolveBlock).toContain("findProperty(name + '_FILE')");
    expect(resolveBlock).toContain(
      "def oxyKeyPassword = oxySigningSecret('OXY_UPLOAD_KEY_PASSWORD') ?: oxyStorePassword",
    );
    // The resolution runs before the `android {` block that uses it.
    expect(signed.indexOf('def oxyUploadSigning')).toBeLessThan(signed.indexOf('\nandroid {'));
  });

  test('a release variant depends on a guard that pins the ecosystem certificate', () => {
    expect(ECOSYSTEM_CERT_SHA256).toBe(
      'b8ab3746466ce4569d7a6a0ffa1eed91bc375174d503613987ca09cb33d6a58d',
    );
    const guard = signed.slice(signed.indexOf("tasks.register('oxyVerifyReleaseSigning')"));
    expect(guard).toContain(`def expected = '${ECOSYSTEM_CERT_SHA256}'`);
    // The EFFECTIVE config, so EAS's injected credentials are checked too.
    expect(guard).toContain('def config = android.buildTypes.getByName(buildType).signingConfig');
    expect(guard).toContain("MessageDigest.getInstance('SHA-256')");
    expect(guard).toContain('throw new GradleException(');
    expect(guard).toContain('if (actual != expected)');
  });

  test('the guard runs before every release variant and never before a debug one', () => {
    // `oxySignDebug ? /<release + debug>/ : /<release>/`
    const patterns = signed.match(/task\.name ==~ \(oxySignDebug \? \/(.+?)\/ : \/(.+?)\/\)/);
    expect(patterns).not.toBeNull();
    const [, withDebug = '', releaseOnly = ''] = patterns ?? [];
    // Groovy's ==~ is a whole-string match.
    const matches = (name: string, pattern = releaseOnly) =>
      new RegExp(`^(?:${pattern})$`).test(name);
    for (const name of ['preDebugBuild', 'validateSigningDebug', 'preReleaseBuild']) {
      expect({ name, optedIn: matches(name, withDebug) }).toEqual({ name, optedIn: true });
    }
    for (const name of ['preDebugUnitTestBuild', 'preDebugAndroidTestBuild', 'assembleDebug']) {
      expect({ name, optedIn: matches(name, withDebug) }).toEqual({ name, optedIn: false });
    }
    for (const name of [
      'preReleaseBuild',
      'validateSigningRelease',
      'preProdReleaseBuild',
      'validateSigningProdRelease',
    ]) {
      expect({ name, guarded: matches(name) }).toEqual({ name, guarded: true });
    }
    for (const name of [
      'preDebugBuild',
      'validateSigningDebug',
      'preReleaseUnitTestBuild',
      'preDebugAndroidTestBuild',
      'assembleDebug',
      'processDebugMainManifest',
      'compileDebugKotlin',
    ]) {
      expect({ name, guarded: matches(name) }).toEqual({ name, guarded: false });
    }
  });

  test('the failure says how to provide the key and never echoes a password', () => {
    const guard = signed.slice(signed.indexOf("tasks.register('oxyVerifyReleaseSigning')"));
    expect(guard).toContain('OXY_UPLOAD_STORE_FILE=');
    expect(guard).toContain('OXY_UPLOAD_STORE_PASSWORD_FILE=');
    expect(guard).toContain('OXY_UPLOAD_KEY_ALIAS=oxy');
    expect(guard).toContain('Debug builds need none of this unless OXY_UPLOAD_SIGN_DEBUG=true.');
    expect(guard).not.toMatch(/\+\s*(config\.)?(storePassword|keyPassword)\b/);
    expect(guard).not.toMatch(/\+\s*oxy(Store|Key)Password\b/);
  });

  test('is idempotent: applied twice (preset + direct listing) it edits once', () => {
    expect(applyReleaseSigning(signed)).toBe(signed);
    expect(signed.split("tasks.register('oxyVerifyReleaseSigning')")).toHaveLength(2);
  });

  test('refuses a build.gradle another signing plugin already edited', () => {
    // What app-preset 4's withOxyAndroidRelease and Mention's own copy write.
    const legacy = TEMPLATE.replace(
      /(signingConfigs\s*\{\s*\n\s*debug\s*\{[\s\S]*?\n\s{8}\}\n)/,
      "$1        release {\n            if (project.hasProperty('OXY_UPLOAD_STORE_FILE')) {\n            }\n        }\n",
    );
    expect(() => applyReleaseSigning(legacy)).toThrow('withOxyAndroidRelease');

    const foreign = TEMPLATE.replace(
      /(signingConfigs\s*\{\s*\n\s*debug\s*\{[\s\S]*?\n\s{8}\}\n)/,
      "$1        release {\n            storeFile file('my.keystore')\n        }\n",
    );
    expect(() => applyReleaseSigning(foreign)).toThrow('already declares signingConfigs.release');

    // Willo's withOxyDebugSigning.
    const willo = TEMPLATE.replace(
      "storeFile file('debug.keystore')",
      "storeFile file(findProperty('OXY_DEBUG_STORE_FILE') ?: 'debug.keystore')",
    );
    expect(() => applyReleaseSigning(willo)).toThrow('OXY_UPLOAD_SIGN_DEBUG=true');
  });

  test('fails loudly when the Expo template changes shape', () => {
    expect(() => applyReleaseSigning(TEMPLATE.replace('signingConfigs {', 'signing {'))).toThrow(
      'signingConfigs.debug',
    );
    expect(() => applyReleaseSigning(TEMPLATE.replace('\nandroid {\n', '\nandroid{\n'))).toThrow(
      '`android {`',
    );
  });

  test('the plugin edits a Groovy build script and refuses a Kotlin one', () => {
    mockGradleMods.length = 0;
    withOxyReleaseSigning({});
    expect(mockGradleMods).toHaveLength(1);
    const [mod] = mockGradleMods;
    expect(
      mod({ modResults: { language: 'groovy', contents: TEMPLATE } }).modResults.contents,
    ).toBe(signed);
    expect(() => mod({ modResults: { language: 'kt', contents: TEMPLATE } })).toThrow('Groovy');
  });

  test('withOxySharedPermissions applies it: declaring the permissions brings the rule', () => {
    const withOxySharedPermissions = require('../../plugins/withOxySharedPermissions') as (
      config: object,
    ) => object;
    mockGradleMods.length = 0;
    withOxySharedPermissions({});
    expect(mockGradleMods).toHaveLength(1);
    expect(
      mockGradleMods[0]({ modResults: { language: 'groovy', contents: TEMPLATE } }).modResults
        .contents,
    ).toBe(signed);
  });
});
