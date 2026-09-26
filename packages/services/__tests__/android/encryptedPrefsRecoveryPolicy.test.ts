/**
 * Pins the rule that no Oxy store can break another's encrypted prefs
 * (OxyHQ/oxy#1388).
 *
 * The androidx master key at `MasterKey.DEFAULT_MASTER_KEY_ALIAS`
 * (`_androidx_security_master_key_`) is UID-scoped: one Keystore entry for the
 * whole `so.oxy.shared` UID, wrapping the keyset of EVERY Oxy prefs file in
 * EVERY Oxy app. A store that deletes it does not only reset itself — it makes
 * every sibling file unreadable, and each of those then wipes itself on its next
 * open. `OxyIdentityStore` used to do exactly that when its keyset could not be
 * rebuilt (`RegenerateSharedMasterKey`); the policy is gone and every store
 * rebuilds only its own file.
 *
 * ## Why this test reads source text
 *
 * No other gate can catch it. There is no gradle/android job in CI, so this Kotlin
 * is not even COMPILED here, let alone executed; and exercising the real recovery
 * path needs an AndroidKeyStore, i.e. an instrumented device test. A source
 * invariant that runs on every `bun run test` is worth more than a perfect test
 * that never runs. Same reasoning as Bloom's `icon-references.test.ts`.
 *
 * It is deliberately built to FAIL LOUDLY rather than pass vacuously: it counts the
 * call sites it found, names the file at risk in the failure message, and prints
 * whole matched lines instead of capture groups.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ANDROID_SOURCE_ROOT = resolve(__dirname, '../../android/src/main/java/so/oxy');

/** Every store opened through `OxyEncryptedPrefs`, and the file that opens it. */
const STORES = [
  { store: 'oxy_shared_identity', file: 'OxyIdentityStore.kt' },
  { store: 'oxy_background_session', file: 'OxyBackgroundSessionStore.kt' },
  { store: 'oxy_shared_device_session', file: 'OxyDeviceSessionStore.kt' },
];

/** Every `.kt` file under the android source tree, so a NEW store cannot hide. */
function kotlinSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return kotlinSources(full);
    }
    return entry.endsWith('.kt') ? [full] : [];
  });
}

interface OpenCallSite {
  file: string;
  /** The whole matched line — never a capture group, so a failure is diagnosable. */
  line: string;
}

function openCallSites(): OpenCallSite[] {
  return kotlinSources(ANDROID_SOURCE_ROOT).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.includes('OxyEncryptedPrefs.open('))
      .map((line) => ({ file, line: line.trim() })),
  );
}

describe('OxyEncryptedPrefs recovery policy', () => {
  test('the android source tree is actually being scanned', () => {
    // Vacuity floor: a broken path or a moved tree must fail here rather than
    // silently turn every assertion below into a pass over an empty list.
    const sources = kotlinSources(ANDROID_SOURCE_ROOT);
    expect(sources.length).toBeGreaterThanOrEqual(9);
    expect(sources.some((f) => f.endsWith('OxyEncryptedPrefs.kt'))).toBe(true);
    expect(sources.some((f) => f.endsWith('OxyIdentityStore.kt'))).toBe(true);
    expect(sources.some((f) => f.endsWith('OxyBackgroundSessionStore.kt'))).toBe(true);
    expect(sources.some((f) => f.endsWith('OxyDeviceSessionStore.kt'))).toBe(true);
  });

  test('every store states its recovery policy explicitly', () => {
    const sites = openCallSites();
    // Three stores today. A FOURTH failing here is the point: adding a store must
    // be a deliberate choice, reviewed with this rule in view — not something
    // inherited by copying a neighbour.
    expect(sites.map((s) => s.line)).toHaveLength(STORES.length);
    for (const site of sites) {
      expect(site.line).toContain('RecoveryPolicy.');
    }
  });

  test.each(STORES)('$store rebuilds only its own file', ({ store, file }) => {
    const site = openCallSites().find((s) => s.file.endsWith(file));
    expect(site).toBeDefined();
    const line = site?.line ?? '';
    expect(line).not.toHaveLength(0);

    // Thrown rather than `expect`ed (jest's expect takes no message) so the
    // failure explains what breaks and why, not just which substring was missing.
    if (!line.includes('RecoveryPolicy.RebuildFileOnly')) {
      throw new Error(
        `${store} must open with RecoveryPolicy.RebuildFileOnly.\n` +
          `  found: ${line}\n\n` +
          'Anything else lets this store reset the androidx master key, which is ONE Keystore ' +
          'entry for the whole so.oxy.shared UID: every other Oxy app would lose its encrypted prefs.',
      );
    }
  });

  test('RebuildFileOnly is the only policy, and it has no default', () => {
    const helper = readFileSync(join(ANDROID_SOURCE_ROOT, 'storage', 'OxyEncryptedPrefs.kt'), 'utf8');
    const enumBody = helper.match(/enum class RecoveryPolicy \{([\s\S]*?)\n\}/);
    expect(enumBody).not.toBeNull();
    const values = (enumBody?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z]\w*,?$/.test(line))
      .map((line) => line.replace(',', ''));
    expect(values).toEqual(['RebuildFileOnly']);

    expect(helper).toContain('recovery: RecoveryPolicy');
    expect(helper).not.toMatch(/recovery:\s*RecoveryPolicy\s*=/);
  });

  test('no Oxy android source deletes a Keystore entry', () => {
    // The master key, and every expo-secure-store alias, is shared by the whole
    // UID. Deleting any Keystore entry from one app is deleting it for all.
    // Comments are stripped first: the history of the rule is documented in
    // KDoc, and naming a key in prose is not deleting it.
    const offenders = kotlinSources(ANDROID_SOURCE_ROOT).filter((file) => {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      return (
        source.includes('deleteEntry(') ||
        source.includes('DEFAULT_MASTER_KEY_ALIAS)') ||
        source.includes('_androidx_security_master_key_')
      );
    });
    expect(offenders).toEqual([]);
  });
});
