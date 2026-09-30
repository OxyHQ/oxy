/**
 * Source invariants of the Commons identity host (`modules/oxy-identity-host`).
 *
 * No CI job compiles this Kotlin, so the properties that make the provider
 * safe are pinned on its source text: the key never goes into an answer, the
 * caller comes from the Binder, and the signature check is there on every API
 * level. Comments are stripped first, so prose about the key is not a hit.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MODULE = resolve(__dirname, '../../modules/oxy-identity-host');
const SRC = resolve(MODULE, 'android/src/main/java/so/oxy/commons/identityhost');

function code(file: string): string {
  return readFileSync(resolve(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[^\n"]*\/\/.*$/gm, '');
}

describe('Commons identity host source', () => {
  const provider = code('OxyIdentityHostProvider.kt');
  const policy = code('OxyCallerPolicy.kt');

  test('the files are really being read', () => {
    expect(provider.length).toBeGreaterThan(1000);
    expect(policy.length).toBeGreaterThan(1000);
  });

  test('no answer carries a private key', () => {
    const puts = provider.split('\n').filter((line) => /\bput(String|Int|Long)\(/.test(line));
    expect(puts.length).toBeGreaterThanOrEqual(6);
    for (const line of puts) {
      // The value put is never the key itself (it may be DERIVED from it, e.g. the seed),
      // and no answer field is named after a private key.
      expect(line).not.toMatch(/put\w+\([^,]+,\s*(privateKey|childPriv\w*)\s*\)/);
      expect(line).not.toMatch(/put\w+\(\s*(KEY_PRIVATE|"priv|"privateKey)/i);
    }
    expect(provider).not.toContain('"privateKey"');
    expect(provider).not.toContain('"priv"');
  });

  test('the caller comes from the Binder, never from the request', () => {
    expect(policy).toContain('Binder.getCallingUid()');
    expect(policy).toContain('getPackagesForUid(');
    expect(provider).not.toMatch(/extras\?*\.getString\("(caller|package|callingPackage)"\)/);
    expect(provider).not.toContain('callingPackage');
  });

  test('the caller must be signed with this app\'s certificate on every API level', () => {
    expect(policy).toContain('hasSigningCertificate(');
    expect(policy).toContain('CERT_INPUT_SHA256');
    expect(policy).toContain('checkSignatures(');
    expect(policy).toContain('SIGNATURE_MATCH');
  });

  test('money-bearing methods are allow-listed to the wallet only', () => {
    expect(policy).toMatch(/WALLET_PACKAGES[^\n]*setOf\("to\.peable\.app", "to\.peable\.app\.dev"\)/);
    expect(policy).toContain('"peable/faircoin/v1"');
  });

  test('the signer module is registered for autolinking', () => {
    const config = JSON.parse(readFileSync(resolve(MODULE, 'expo-module.config.json'), 'utf8')) as {
      android?: { modules?: string[] };
    };
    expect(config.android?.modules).toEqual(['so.oxy.commons.identityhost.OxyIdentitySignerModule']);
  });
});
