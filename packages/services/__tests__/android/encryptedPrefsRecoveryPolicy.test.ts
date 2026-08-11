/**
 * Pins the one rule that stops a DISPOSABLE encrypted store from destroying an
 * IRREPLACEABLE one.
 *
 * `OxyEncryptedPrefs` can, as a last resort, delete the androidx master key at
 * `MasterKey.DEFAULT_MASTER_KEY_ALIAS`. That alias is UID-scoped: one entry for the
 * whole `so.oxy.shared` UID, wrapping the keyset of EVERY Oxy prefs file. So a
 * store that reaches that escalation does not only reset itself — it makes every
 * sibling file unreadable, and each of those then wipes itself on its next open.
 *
 * `oxy_background_session` holds a credential the app re-provisions on its next
 * foreground. `oxy_shared_identity` holds the self-custody identity keypair, which
 * cannot be re-created. If the disposable store could escalate, a widget's
 * throwaway credential failing to open would destroy the user's identity key.
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

/** The store whose loss is unrecoverable, named in failures so the stakes are legible. */
const IRREPLACEABLE_STORE = 'oxy_shared_identity';

/**
 * Every store whose contents some other authority can re-create, and which
 * therefore must NOT be allowed to escalate to a UID-shared master-key reset.
 *
 * `oxy_background_session` holds a credential the app re-provisions on its next
 * foreground. `oxy_shared_device_session` holds the cross-app DeviceSession
 * credential, which every signed-in app re-publishes from its own durable copy.
 * Losing either costs at most one sign-in; escalating destroys an identity.
 */
const DISPOSABLE_STORES = [
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
    // be a deliberate choice about what it may destroy, reviewed with this rule in
    // view — not something inherited by copying a neighbour.
    expect(sites.map((s) => s.line)).toHaveLength(3);
    for (const site of sites) {
      expect(site.line).toMatch(/RecoveryPolicy\.(RebuildFileOnly|RegenerateSharedMasterKey)/);
    }
  });

  test.each(DISPOSABLE_STORES)(
    `$store cannot delete the master key that protects ${IRREPLACEABLE_STORE}`,
    ({ store, file }) => {
      const site = openCallSites().find((s) => s.file.endsWith(file));
      expect(site).toBeDefined();
      const line = site?.line ?? '';
      expect(line).not.toHaveLength(0);

      // The whole safety property. Thrown rather than `expect`ed (jest's expect takes
      // no message) so the failure explains what breaks and why, not just which
      // substring was missing — whoever trips this needs the stakes, not a diff.
      if (!line.includes('RecoveryPolicy.RebuildFileOnly')) {
        throw new Error(
          `${store} must open with RecoveryPolicy.RebuildFileOnly.\n` +
            `  found: ${line}\n\n` +
            `It holds data some other authority re-creates on demand, so giving up ` +
            `costs the user at most one sign-in. Escalating instead deletes the UID-shared androidx ` +
            `master key, which makes every sibling Oxy store unreadable — including ${IRREPLACEABLE_STORE}, ` +
            `the self-custody identity keypair, which CANNOT be re-created. As written, a throwaway ` +
            `credential failing to open would destroy the user's identity key.`,
        );
      }
    },
  );

  test('the identity store keeps its original escalating behaviour', () => {
    const site = openCallSites().find((s) => s.file.endsWith('OxyIdentityStore.kt'));
    expect(site).toBeDefined();
    // Not merely permitted but REQUIRED: the refactor that introduced the policy
    // must not have quietly changed what this store does on an unreadable keyset.
    expect(site?.line).toContain('RecoveryPolicy.RegenerateSharedMasterKey');
  });

  test('the master key is deleted in exactly one place, and the policy has no default', () => {
    const deleters = kotlinSources(ANDROID_SOURCE_ROOT).filter((file) =>
      readFileSync(file, 'utf8').includes('deleteEntry(MasterKey.DEFAULT_MASTER_KEY_ALIAS)'),
    );
    expect(deleters).toHaveLength(1);
    expect(deleters[0].endsWith('OxyEncryptedPrefs.kt')).toBe(true);

    const helper = readFileSync(deleters[0], 'utf8');
    // The parameter must be required. A default value would let a future store
    // inherit the destructive policy by simply not mentioning it — exactly the
    // accident this whole mechanism exists to prevent.
    expect(helper).toContain('recovery: RecoveryPolicy');
    expect(helper).not.toMatch(/recovery:\s*RecoveryPolicy\s*=/);
  });
});
