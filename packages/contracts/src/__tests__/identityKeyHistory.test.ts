import { identityKeyHistorySchema, safeParseContract } from '../index';

const key = (fill: string) => `04${fill.repeat(128)}`;

describe('identityKeyHistorySchema', () => {
  it('round-trips a rotated account and a keyless one', () => {
    const rotated = {
      publicKey: key('c'),
      retired: [
        { publicKey: key('a'), retiredAt: '2026-11-01T10:00:00.000Z' },
        { publicKey: key('b'), retiredAt: '2026-11-05T10:00:00.000Z' },
      ],
    };
    expect(safeParseContract(identityKeyHistorySchema, rotated)).toEqual(rotated);
    const keyless = { publicKey: null, retired: [] };
    expect(safeParseContract(identityKeyHistorySchema, keyless)).toEqual(keyless);
  });

  it('accepts only canonical keys: uncompressed, lowercase', () => {
    for (const publicKey of [`02${'a'.repeat(64)}`, key('A'), key('a').slice(0, -1), '']) {
      expect(safeParseContract(identityKeyHistorySchema, { publicKey, retired: [] })).toBeNull();
      expect(
        safeParseContract(identityKeyHistorySchema, {
          publicKey: null,
          retired: [{ publicKey, retiredAt: '2026-11-01T10:00:00.000Z' }],
        }),
      ).toBeNull();
    }
  });

  it('refuses an unknown field, so nothing beyond the keys can be added unseen', () => {
    expect(
      safeParseContract(identityKeyHistorySchema, {
        publicKey: null,
        retired: [],
        holders: [],
      }),
    ).toBeNull();
    expect(
      safeParseContract(identityKeyHistorySchema, {
        publicKey: null,
        retired: [{ publicKey: key('a'), retiredAt: '2026-11-01T10:00:00.000Z', userId: 'u' }],
      }),
    ).toBeNull();
  });
});
