/**
 * Pins the separation the shared DeviceSession credential exists to create, and
 * the manifest wiring that makes it enforceable.
 *
 * Two secrets can make an Oxy app boot signed in:
 *
 *   the Commons private identity key  — self-custody, IRREPLACEABLE, signs
 *                                       identity approvals;
 *   the DeviceSession credential      — an ordinary rotatable, server-revocable
 *                                       `deviceId` + `deviceSecret`.
 *
 * An ordinary app needs the second. This file fails if the two ever start
 * reaching into each other's storage, if the cross-process read stops being
 * signature-gated, or if the hand-maintained authority lists drift apart.
 *
 * ## Why this test reads source text
 *
 * The same reason as `encryptedPrefsRecoveryPolicy.test.ts` next door: there is
 * no gradle/android job in CI, so this Kotlin is not even COMPILED here, and
 * exercising a real ContentProvider needs an instrumented device. A source
 * invariant that runs on every `bun run test` is worth more than a perfect test
 * that never runs.
 *
 * It is built to fail loudly rather than pass vacuously: every scan has a floor,
 * and the authority comparison names the file that disagrees.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG_ROOT = resolve(__dirname, '../..');

const DEVICE_SESSION_SOURCES = [
  'android/src/main/java/so/oxy/devicesession/OxyDeviceSessionStore.kt',
  'android/src/main/java/so/oxy/devicesession/OxyDeviceSessionProvider.kt',
  'android/src/main/java/so/oxy/devicesession/OxyDeviceSessionModule.kt',
];

const IDENTITY_SOURCES = [
  'android/src/main/java/so/oxy/identity/OxyIdentityStore.kt',
  'android/src/main/java/so/oxy/identity/OxyIdentityProvider.kt',
  'android/src/main/java/so/oxy/identity/OxyIdentityModule.kt',
];

const PROVIDER_PLUGIN = 'plugins/withSharedDeviceSessionProvider.js';
const READER_PLUGIN = 'plugins/withSharedDeviceSessionReader.js';
const MODULE_KT = 'android/src/main/java/so/oxy/devicesession/OxyDeviceSessionModule.kt';

const READ_DEVICE_SESSION_PERMISSION = 'so.oxy.shared.permission.READ_DEVICE_SESSION';
const READ_IDENTITY_PERMISSION = 'so.oxy.shared.permission.READ_IDENTITY';

function read(relative: string): string {
  return readFileSync(resolve(PKG_ROOT, relative), 'utf8');
}

/**
 * The file with comments stripped, so the boundary scan measures REFERENCES and
 * not prose. The doc comments in these files talk about the identity store on
 * purpose — explaining why the two are separate is the most useful thing they
 * can say, and a gate that forbade saying it would be a gate against comments.
 */
function readCode(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[^\n"]*\/\/.*$/gm, '');
}

/**
 * Every `so.oxy.…devicesession` authority string in a file, deduped and sorted.
 * Matches the LITERAL strings in either quote style (Kotlin uses `"`, the
 * plugins use `'`), so a list expressed as a template or a loop simply yields
 * nothing here — which the floor below turns into a failure rather than a pass.
 */
function authoritiesIn(relative: string): string[] {
  const matches = read(relative).match(/['"]so\.oxy\.[a-z.]*devicesession['"]/g) ?? [];
  return Array.from(new Set(matches.map((m) => m.slice(1, -1)))).sort();
}

describe('shared DeviceSession credential — Android wiring', () => {
  test('the files this suite asserts about are actually being read', () => {
    // Vacuity floor. A moved or renamed file must fail here rather than silently
    // turn every assertion below into a pass over an empty string.
    for (const relative of [...DEVICE_SESSION_SOURCES, ...IDENTITY_SOURCES, PROVIDER_PLUGIN, READER_PLUGIN]) {
      expect(read(relative).length).toBeGreaterThan(500);
    }
  });

  test('the device-session tree never reaches into identity storage', () => {
    // The separation, stated as code rather than as prose in a design doc. An
    // app that only needs a session must not be able to obtain the key that
    // signs identity approvals, and the first sign of that boundary eroding is
    // one of these names appearing here.
    const forbidden = ['OxyIdentityStore', 'OxyIdentityProvider', 'oxy_shared_identity', 'privateKey', 'publicKey'];
    for (const relative of DEVICE_SESSION_SOURCES) {
      const source = readCode(relative);
      for (const name of forbidden) {
        if (source.includes(name)) {
          throw new Error(
            `${relative} references '${name}'.\n\n` +
              `The shared DeviceSession credential is deliberately separate from the self-custody ` +
              `identity keypair: it is an ordinary rotatable, server-revocable secret, while the ` +
              `identity key cannot be re-created if it leaks or is lost. Reaching across that ` +
              `boundary is how "ordinary apps do not need Commons private key access" stops being true.`,
          );
        }
      }
    }
  });

  test('the identity tree never reaches into device-session storage', () => {
    // The same wall, from the other side — so a future refactor cannot merge them
    // by moving the code rather than by importing it.
    for (const relative of IDENTITY_SOURCES) {
      const source = readCode(relative);
      expect(source).not.toContain('OxyDeviceSessionStore');
      expect(source).not.toContain('oxy_shared_device_session');
    }
  });

  test('the two stores are different encrypted files', () => {
    // Same androidx master key, different files — so a stage-1 keyset heal on the
    // disposable one cannot take the identity keypair with it.
    expect(read(DEVICE_SESSION_SOURCES[0])).toContain('"oxy_shared_device_session"');
    expect(read(IDENTITY_SOURCES[0])).toContain('"oxy_shared_identity"');
  });

  test('the cross-process read is signature-gated', () => {
    const provider = read('android/src/main/java/so/oxy/devicesession/OxyDeviceSessionProvider.kt');
    // Same-signature is the entire trust boundary for an Android app outside the
    // shared UID. Without this an incorrectly-signed app reads the slot.
    expect(provider).toContain('PackageManager.SIGNATURE_MATCH');
    expect(provider).toContain('callingPackage ?: return false');
  });

  test('the provider is read-only across the process boundary', () => {
    const provider = readCode('android/src/main/java/so/oxy/devicesession/OxyDeviceSessionProvider.kt');
    // A sibling may JOIN the device session. Letting it write would let any
    // same-signature app move every other app onto a session of its choosing.
    expect(provider).toContain('if (method != METHOD_READ) return null');
    expect(provider).not.toContain('OxyDeviceSessionStore.write');
    expect(provider).not.toContain('OxyDeviceSessionStore.clear');
  });

  test('the provider maps each read outcome to its OWN status', () => {
    // The rule the whole three-state design exists for: a store the provider
    // could not READ must not be reported as a store that is EMPTY. The empty
    // answer authorises the caller to seed the slot; the failed answer authorises
    // nothing. Asserting per-arm rather than just "the file mentions
    // STATUS_UNAVAILABLE" — a collapsed arm leaves the constant in the file.
    const provider = readCode('android/src/main/java/so/oxy/devicesession/OxyDeviceSessionProvider.kt');
    const arms: [string, string][] = [
      ['Present', 'STATUS_PRESENT'],
      ['Absent', 'STATUS_ABSENT'],
      ['Unavailable', 'STATUS_UNAVAILABLE'],
    ];
    const marker = (name: string) => `is DeviceSessionRead.${name} ->`;
    for (const [name, expected] of arms) {
      const start = provider.indexOf(marker(name));
      expect(start).toBeGreaterThanOrEqual(0);
      const rest = provider.slice(start + marker(name).length);
      const nextArm = arms
        .map(([other]) => rest.indexOf(marker(other)))
        .filter((index) => index >= 0);
      const body = rest.slice(0, nextArm.length > 0 ? Math.min(...nextArm) : undefined);
      const emitted = arms.map(([, status]) => status).filter((status) => body.includes(status));
      if (emitted.join() !== expected) {
        throw new Error(
          `The provider's '${name}' arm emits ${emitted.join(', ') || '(no status)'}, expected ${expected}.\n\n` +
            'Present / absent / unavailable are three different answers and only "absent" may ' +
            'authorise a caller to write into the slot. An arm that reports a failed read as an ' +
            'empty one is how a locked or broken keystore ends up overwriting a live session.',
        );
      }
    }
  });

  test('the sweep never turns an unreadable source into an empty one', () => {
    // Same rule, one layer up: the module merges several sources, and every
    // `DeviceSessionRead.Absent` it PRODUCES must come from a peer that actually
    // said `absent`. A fallback arm resolving to `Absent` — for an unrecognised
    // status, say — silently converts "I could not tell" into "there is none".
    const module = readCode(MODULE_KT);
    const producing = module
      .split('\n')
      .filter((line) => line.includes('-> DeviceSessionRead.Absent'));
    // Floor: if this finds nothing the assertion below is vacuous.
    expect(producing.length).toBeGreaterThanOrEqual(1);
    for (const line of producing) {
      if (!line.includes('STATUS_ABSENT')) {
        throw new Error(
          `${MODULE_KT} produces DeviceSessionRead.Absent from a source that did not report absent:\n` +
            `  ${line.trim()}\n\n` +
            'Only a peer answering STATUS_ABSENT may yield Absent. Everything else — an ' +
            'unrecognised status, a failed call, a peer that could not read its own store — is ' +
            'Unavailable, because the JS side treats Absent as permission to seed the slot.',
        );
      }
    }
  });

  test('the manifest gate uses its OWN signature-level permission', () => {
    const plugin = readCode(PROVIDER_PLUGIN);
    expect(plugin).toContain(READ_DEVICE_SESSION_PERMISSION);
    expect(plugin).toContain("'android:protectionLevel': 'signature'");
    expect(plugin).toContain("'android:permission': READ_DEVICE_SESSION_PERMISSION");
    // Distinct from the identity permission: granting an app the right to join a
    // device session must not grant it the right to read an identity key.
    expect(READ_DEVICE_SESSION_PERMISSION).not.toBe(READ_IDENTITY_PERMISSION);
    expect(plugin).not.toContain(READ_IDENTITY_PERMISSION);
    expect(readCode(READER_PLUGIN)).not.toContain(READ_IDENTITY_PERMISSION);
  });

  test('the reader plugin requests the permission but hosts nothing', () => {
    const reader = readCode(READER_PLUGIN);
    expect(reader).toContain(READ_DEVICE_SESSION_PERMISSION);
    expect(reader).not.toContain('OxyDeviceSessionProvider');
    expect(reader).not.toContain('app.provider');
  });

  test('the Kotlin sweep and BOTH plugins list exactly the same authorities', () => {
    const kotlin = authoritiesIn(MODULE_KT);
    const provider = authoritiesIn(PROVIDER_PLUGIN);
    const reader = authoritiesIn(READER_PLUGIN);

    // Floor first: three empty lists would otherwise "agree" perfectly.
    expect(kotlin.length).toBeGreaterThanOrEqual(2);

    // A `<queries>` entry missing for an authority the Kotlin sweeps means
    // Android 11+ package-visibility hides that provider and the sweep silently
    // finds nothing — a drift with no error message anywhere.
    if (provider.join() !== kotlin.join() || reader.join() !== kotlin.join()) {
      throw new Error(
        'The shared DeviceSession provider authorities have drifted.\n' +
          `  ${MODULE_KT}: ${kotlin.join(', ') || '(none)'}\n` +
          `  ${PROVIDER_PLUGIN}: ${provider.join(', ') || '(none)'}\n` +
          `  ${READER_PLUGIN}: ${reader.join(', ') || '(none)'}\n\n` +
          'The Kotlin list decides who is swept; the plugin lists decide who is VISIBLE ' +
          'under Android 11+ package filtering. An authority in one and not the others is ' +
          'either never asked or asked and invisible — both fail silently, with the app ' +
          'simply never joining the device session.',
      );
    }
  });

  test('the native module is registered for autolinking', () => {
    // A module missing from here resolves to `null` through
    // `requireOptionalNativeModule`, which the JS side reads as `unsupported` —
    // no error, the feature is just off.
    const config = JSON.parse(read('expo-module.config.json')) as { android?: { modules?: string[] } };
    expect(config.android?.modules).toContain('so.oxy.devicesession.OxyDeviceSessionModule');
  });

  test('the native sources ship in the published package', () => {
    const pkg = JSON.parse(read('package.json')) as { files?: string[] };
    expect(pkg.files).toContain('android/src');
    expect(pkg.files).toContain('plugins');
  });
});
