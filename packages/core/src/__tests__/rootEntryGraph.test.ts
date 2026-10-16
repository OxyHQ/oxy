/**
 * The root entry (`@oxy.so/core`) stays light.
 *
 * An app that only calls the API must not ship the self-custody identity
 * (secp256k1, bip39, the AEAD cipher), the public-suffix list, or the inference
 * client. Those live behind their own entries (`/crypto`, `/server`,
 * `/inference`) and the namespaces that need them load them with `import()` on
 * first use. This walks the STATIC value-import graph of `src/index.ts` — the
 * graph every bundler, Metro included, must include — and asserts none of them
 * is on it. Dynamic `import()` and type-only imports are not edges.
 */
import { join, relative, resolve } from 'node:path';
import { walkImportGraph } from './fixtures/importGraph';

const SRC = resolve(__dirname, '..');
const ROOT_ENTRY = join(SRC, 'index.ts');

function walk(entry: string): { files: Set<string>; external: Set<string> } {
  const graph = walkImportGraph(entry);
  return { files: graph.files, external: new Set(graph.external.keys()) };
}

describe('@oxy.so/core root entry graph', () => {
  const { files, external } = walk(ROOT_ENTRY);
  const reached = [...files].map((f) => relative(SRC, f));

  it('reaches a real graph (the walk is not vacuous)', () => {
    expect(reached).toContain('OxyServices.ts');
    expect(reached).toContain('HttpService.ts');
    expect(reached).toContain('api/users.ts');
  });

  it.each([
    'crypto/keyManager.ts',
    'crypto/recoveryPhrase.ts',
    'crypto/aead.ts',
    'crypto/signatureService.ts',
    'crypto/registrationPow.ts',
    'utils/registrableApex.ts',
    'inference/OxyInferenceClient.ts',
    'session/SessionClient.ts',
    'session/accountDialogController.ts',
  ])('does not statically reach %s', (file) => {
    expect(reached).not.toContain(file);
  });

  it('reaches no heavy third-party crypto or the public-suffix list', () => {
    const heavy = [...external].filter((spec) => /^@scure\/|^@noble\/curves|^tldts/.test(spec));
    expect(heavy).toEqual([]);
  });

  it('ships only the English dictionary statically', () => {
    const locales = reached.filter((f) => f.startsWith('i18n/locales/'));
    expect(locales).toEqual(['i18n/locales/en-US.ts']);
  });
});

/**
 * `@oxy.so/core/session` — the cold boot every app runs before first paint —
 * reaches the identity key only through `import()` where a key operation
 * happens (`identitySession`'s default binding), so a client without a key
 * never evaluates secp256k1, bip39 or the AEAD cipher at startup.
 */
describe('@oxy.so/core/session entry graph', () => {
  const { files, external } = walk(join(SRC, 'session/index.ts'));
  const reached = [...files].map((f) => relative(SRC, f));

  it('reaches the cold boot (the walk is not vacuous)', () => {
    expect(reached).toContain('boot/sessionColdBoot.ts');
    expect(reached).toContain('session/identitySession.ts');
  });

  it.each([
    'crypto/keyManager.ts',
    'crypto/signatureService.ts',
    'crypto/recoveryPhrase.ts',
    'crypto/aead.ts',
    'crypto/index.ts',
  ])('does not statically reach %s', (file) => {
    expect(reached).not.toContain(file);
  });

  it('reaches no heavy third-party crypto', () => {
    expect([...external].filter((spec) => /^@scure\/|^@noble\//.test(spec))).toEqual([]);
  });
});
