import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import en from '@/lib/i18n/locales/en.json';
import es from '@/lib/i18n/locales/es.json';

/**
 * The ID card's printed labels ("IDENTITY CARD", "NAME", …) were English in
 * every language. They are translated now and engraved in capitals by the
 * card itself (`toLocaleUpperCase`); only the MRZ stays in ICAO's A-Z.
 */
const FACES = [
  'components/OxyID/front-side.tsx',
  'components/OxyID/back-side.tsx',
  'components/civic/IdQrBack.tsx',
];
const LABELS = [
  'docTypeIdentity',
  'name',
  'type',
  'selfCustody',
  'username',
  'idNumber',
  'issued',
  'notAvailable',
  'docTypePublicKey',
  'publicKey',
  'holder',
  'docTypeVerify',
];

describe('ID card labels', () => {
  it.each(FACES)('%s prints no hard-coded English label', (path) => {
    const source = readFileSync(resolve(__dirname, '../..', path), 'utf8');
    // A JSX text node that is a run of capitals ("IDENTITY CARD"), or the N/A fallback.
    expect(source).not.toMatch(/>\s*[A-Z][A-Z -]{2,}\s*</);
    expect(source).not.toMatch(/'N\/A'/);
  });

  it('has every label in English and Spanish', () => {
    for (const dict of [en, es] as unknown as {
      civic: { id: { card: Record<string, string> } };
    }[]) {
      for (const key of LABELS) {
        expect(dict.civic.id.card[key]).toEqual(expect.any(String));
      }
    }
    expect(es.civic.id.card.docTypeIdentity).not.toBe(en.civic.id.card.docTypeIdentity);
  });
});
