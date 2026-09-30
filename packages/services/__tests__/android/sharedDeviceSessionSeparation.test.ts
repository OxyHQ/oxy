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
 * An ordinary app needs the second, and on Android only Commons ever holds the
 * first. This file fails if the two ever start reaching into each other's
 * storage, if the cross-process calls stop being signature-gated or start
 * trusting the caller's word for who it is, if a non-host app keeps its own
 * copy, or if the hand-maintained authority and caller lists drift apart.
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

const IDENTITY_SOURCES = ['android/src/main/java/so/oxy/identity/OxyIdentityModule.kt'];

const PROVIDER_PLUGIN = 'plugins/withSharedDeviceSessionProvider.js';
const PERMISSIONS_PLUGIN = 'plugins/withOxySharedPermissions.js';
const MODULE_KT = 'android/src/main/java/so/oxy/devicesession/OxyDeviceSessionModule.kt';
const PROVIDER_KT = 'android/src/main/java/so/oxy/devicesession/OxyDeviceSessionProvider.kt';
const CALLER_POLICY_KT = 'android/src/main/java/so/oxy/security/OxyCallerPolicy.kt';
/** Commons' identity host keeps its own copy of the caller list. */
const COMMONS_CALLER_POLICY_KT =
  '../commons/modules/oxy-identity-host/android/src/main/java/so/oxy/commons/identityhost/OxyCallerPolicy.kt';

const DEVICE_SESSION_PERMISSION = 'so.oxy.permission.DEVICE_SESSION';
const IDENTITY_PERMISSION = 'so.oxy.permission.IDENTITY';

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
 * The body of the brace-delimited block that follows `header`, by brace
 * matching.
 *
 * Needed because the arms of a `when` are only bounded by the block's closing
 * brace: scanning "from this arm to the next one" runs the LAST arm to the end
 * of the file, where the companion object's constants make every assertion about
 * that arm pass.
 */
function blockAfter(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start < 0) {
    throw new Error(`could not find '${header}'`);
  }
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') {
      depth += 1;
    } else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  throw new Error(`unterminated block after '${header}'`);
}

/**
 * Every `so.oxy.…devicesession` authority string in a file, deduped and sorted.
 * Matches the LITERAL strings in either quote style (Kotlin uses `"`, the
 * plugins use `'`), so a list expressed as a template or a loop simply yields
 * nothing here — which the floor below turns into a failure rather than a pass.
 */
function authoritiesIn(relative: string, kind = 'devicesession'): string[] {
  const matches = read(relative).match(new RegExp(`['"]so\\.oxy\\.[a-z.]*${kind}['"]`, 'g')) ?? [];
  return Array.from(new Set(matches.map((m) => m.slice(1, -1)))).sort();
}

/** The string literals of the `OXY_PACKAGES` set in a caller policy. */
function callerPackagesIn(relative: string): string[] {
  const block = blockAfter(read(relative).replace('setOf(', 'setOf{').replace(/\n {2}\)\n/, '\n  }\n'), 'val OXY_PACKAGES');
  return (block.match(/"[a-z.]+"/g) ?? []).map((m) => m.slice(1, -1)).sort();
}

describe('shared DeviceSession credential — Android wiring', () => {
  test('the files this suite asserts about are actually being read', () => {
    // Vacuity floor. A moved or renamed file must fail here rather than silently
    // turn every assertion below into a pass over an empty string.
    for (const relative of [
      ...DEVICE_SESSION_SOURCES,
      ...IDENTITY_SOURCES,
      PROVIDER_PLUGIN,
      PERMISSIONS_PLUGIN,
      CALLER_POLICY_KT,
      COMMONS_CALLER_POLICY_KT,
    ]) {
      expect(read(relative).length).toBeGreaterThan(500);
    }
  });

  test('the device-session tree never reaches into identity storage', () => {
    // The separation, stated as code rather than as prose in a design doc. An
    // app that only needs a session must not be able to obtain the key that
    // signs identity approvals, and the first sign of that boundary eroding is
    // one of these names appearing here.
    const forbidden = ['OxyIdentity', 'oxy_identity', 'identity.', 'privateKey', 'publicKey'];
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

  test('this package holds no identity key at all', () => {
    // Commons is the ONLY holder of the identity private key on Android. The
    // identity module here is a client: it asks Commons for proofs and derived
    // values, and nothing in it stores, reads or returns a key.
    const module = readCode(IDENTITY_SOURCES[0]);
    for (const name of ['OxyEncryptedPrefs', 'SharedPreferences', 'getShared', 'putShared', 'privateKey', '"priv"']) {
      expect(module).not.toContain(name);
    }
    expect(module).toContain('contentResolver.call(');
  });

  test('every cross-process call is gated by the caller the Binder reports', () => {
    const provider = readCode(PROVIDER_KT);
    // The manifest permission is necessary but not sufficient: the provider asks
    // the policy, before any method runs, who is calling.
    const resolve = provider.indexOf('OxyCallerPolicy.resolveCaller(ctx');
    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(resolve).toBeLessThan(provider.indexOf('return when (method)'));
    expect(provider).not.toContain('callingPackage');

    const policy = readCode(CALLER_POLICY_KT);
    // Who is calling comes from the kernel, never from the request.
    expect(policy).toContain('Binder.getCallingUid()');
    expect(policy).toContain('getPackagesForUid(uid)');
    expect(policy).toContain('hasSigningCertificate(pkg, digest, PackageManager.CERT_INPUT_SHA256)');
    expect(policy).toContain('checkSignatures(pkg, context.packageName) == PackageManager.SIGNATURE_MATCH');
    expect(policy).not.toContain('extras');
  });

  test('the provider answers read, write and clear, and nothing else', () => {
    const provider = readCode(PROVIDER_KT);
    // Every host keeps ONE copy, which every Oxy app reads AND publishes into:
    // without a cross-process write, an app that signs in could not hand the
    // device session to the others, because no app can see another's files.
    expect(provider).toContain('if (method != METHOD_READ && method != METHOD_WRITE && method != METHOD_CLEAR) return null');
    expect(provider).toContain('OxyDeviceSessionStore.write(ctx, deviceId, deviceSecret)');
  });

  test('a publish never leaves a host holding an older credential', () => {
    // The sweep adopts the FIRST host with a credential. If the first host
    // refused a write while a later one took it, every app would adopt the
    // first host's stale secret, fail, re-sign-in and publish again, forever.
    // So a host that did not confirm is cleared, and the write only counts when
    // no installed host is left stale.
    const module = readCode(MODULE_KT);
    const publish = blockAfter(module, 'private fun publish(deviceId: String, deviceSecret: String): Boolean');
    expect(publish).toContain('if (!isInstalled(authority)) continue');
    expect(publish).toContain('} else if (!clearHost(authority)) {');
    expect(publish).toContain('return confirmed > 0 && !stale');
    // A clear is only as good as its read-back.
    expect(readCode(DEVICE_SESSION_SOURCES[0])).toMatch(/fun clear\(context: Context\): Boolean/);
    expect(readCode(PROVIDER_KT)).toContain('putBoolean(KEY_OK, OxyDeviceSessionStore.clear(ctx))');
  });

  test('an app that is not a host keeps no copy of its own', () => {
    // Every store access in the module is for the host itself; a non-host goes
    // through the hosts' providers only, so there is exactly one credential per
    // host and no private mirror that could shadow it.
    const module = readCode(MODULE_KT);
    const storeCalls = module.split('\n').filter((line) => line.includes('OxyDeviceSessionStore.'));
    expect(storeCalls.length).toBeGreaterThanOrEqual(3);
    for (const line of storeCalls) {
      const guarded =
        line.includes('authority == selfAuthority') ||
        line.includes('KEY_DEVICE_') ||
        /^\s*OxyDeviceSessionStore\.(write|clear)\(context/.test(line);
      expect({ line: line.trim(), guarded }).toEqual({ line: line.trim(), guarded: true });
    }
    expect(module).toContain('if (authority == selfAuthority) OxyDeviceSessionStore.read(context) else callProvider(authority)');
  });

  test('the provider maps each read outcome to its OWN status', () => {
    // The rule the whole three-state design exists for: a store the provider
    // could not READ must not be reported as a store that is EMPTY. The empty
    // answer authorises the caller to seed the slot; the failed answer authorises
    // nothing. Asserting per-arm rather than just "the file mentions
    // STATUS_UNAVAILABLE" — a collapsed arm leaves the constant in the file.
    const provider = readCode('android/src/main/java/so/oxy/devicesession/OxyDeviceSessionProvider.kt');
    const when = blockAfter(provider, 'private fun readBundle(read: DeviceSessionRead)');
    const arms: [string, string][] = [
      ['Present', 'STATUS_PRESENT'],
      ['Absent', 'STATUS_ABSENT'],
      ['Unavailable', 'STATUS_UNAVAILABLE'],
    ];
    const marker = (name: string) => `is DeviceSessionRead.${name} ->`;
    for (const [name, expected] of arms) {
      const start = when.indexOf(marker(name));
      expect(start).toBeGreaterThanOrEqual(0);
      const rest = when.slice(start + marker(name).length);
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
    expect(plugin).toContain(DEVICE_SESSION_PERMISSION);
    expect(plugin).toContain("'android:permission': DEVICE_SESSION_PERMISSION");
    // Distinct from the identity permission: granting an app the right to join a
    // device session must not grant it the right to ask for identity proofs.
    expect(DEVICE_SESSION_PERMISSION).not.toBe(IDENTITY_PERMISSION);
    expect(plugin).not.toContain(IDENTITY_PERMISSION);
  });

  test('only withOxySharedPermissions declares the permissions', () => {
    // Every declaration of a signature permission must be identical across the
    // apps that declare it, so exactly one plugin writes them.
    expect(readCode(PROVIDER_PLUGIN)).not.toContain("'android:protectionLevel'");
    expect(readCode(PROVIDER_PLUGIN)).not.toContain('uses-permission');
    const permissions = readCode(PERMISSIONS_PLUGIN);
    expect(permissions).toContain("'android:protectionLevel': 'signature'");
    expect(permissions).toContain(`'${DEVICE_SESSION_PERMISSION}'`);
    expect(permissions).toContain(`'${IDENTITY_PERMISSION}'`);
  });

  test('the Kotlin sweep and BOTH plugins list exactly the same device-session hosts', () => {
    const kotlin = authoritiesIn(MODULE_KT);
    const provider = authoritiesIn(PROVIDER_PLUGIN);
    const queries = authoritiesIn(PERMISSIONS_PLUGIN);

    // Floor first: three empty lists would otherwise "agree" perfectly.
    expect(kotlin.length).toBeGreaterThanOrEqual(2);

    // A `<queries>` entry missing for an authority the Kotlin sweeps means
    // Android 11+ package-visibility hides that provider and the sweep silently
    // finds nothing — a drift with no error message anywhere.
    if (provider.join() !== kotlin.join() || queries.join() !== kotlin.join()) {
      throw new Error(
        'The shared DeviceSession host authorities have drifted.\n' +
          `  ${MODULE_KT}: ${kotlin.join(', ') || '(none)'}\n` +
          `  ${PROVIDER_PLUGIN}: ${provider.join(', ') || '(none)'}\n` +
          `  ${PERMISSIONS_PLUGIN}: ${queries.join(', ') || '(none)'}\n\n` +
          'The Kotlin list decides who is swept and written; the queries decide who is VISIBLE ' +
          'under Android 11+ package filtering. An authority in one and not the others is ' +
          'either never asked or asked and invisible — both fail silently, with the app ' +
          'simply never joining the device session.',
      );
    }
  });

  test('the identity client and the queries list the same Commons authorities', () => {
    const kotlin = authoritiesIn(IDENTITY_SOURCES[0], 'identity');
    expect(kotlin).toEqual(['so.oxy.commons.dev.identity', 'so.oxy.commons.identity']);
    expect(authoritiesIn(PERMISSIONS_PLUGIN, 'identity')).toEqual(kotlin);
  });

  test('the device-session and Commons identity hosts allow the same Oxy apps', () => {
    const here = callerPackagesIn(CALLER_POLICY_KT);
    const commons = callerPackagesIn(COMMONS_CALLER_POLICY_KT);
    expect(here.length).toBeGreaterThanOrEqual(20);
    // Every Oxy app ships in prod and dev.
    for (const pkg of here.filter((p) => !p.endsWith('.dev'))) {
      expect(here).toContain(`${pkg}.dev`);
    }
    if (here.join() !== commons.join()) {
      throw new Error(
        'The Oxy caller allow-lists have drifted.\n' +
          `  ${CALLER_POLICY_KT}: ${here.join(', ')}\n` +
          `  ${COMMONS_CALLER_POLICY_KT}: ${commons.join(', ')}\n\n` +
          'An app on one list and not the other joins the device session but cannot sign in ' +
          'with Commons, or the reverse.',
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
