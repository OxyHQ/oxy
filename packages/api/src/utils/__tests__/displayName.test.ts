/**
 * Unit tests for the `name.displayName` composition (the logic backing the
 * `User.name.displayName` Mongoose virtual — see `models/User.ts`).
 *
 * The composition returns the user's REAL name only:
 *
 *   explicit name.displayName → name.full (from first/last) → undefined
 *
 * It does NOT synthesize a name from `username` / `publicKey` / `'Anonymous'`.
 * When there is no real name the helper returns `undefined`, the serializer
 * omits `name.displayName`, and consumers fall back to the handle.
 *
 * The API jest setup mocks Mongoose wholesale, so the model's virtual getter
 * never runs under test; the rules are exercised here against the pure helper
 * the virtual delegates to.
 */

import {
  composeDisplayName,
  composeFullName,
  formatUserNameResponse,
  resolveEmailFromName,
  truncatePublicKeyHandle,
} from '../displayName';

describe('composeDisplayName (User.name.displayName — real name only)', () => {
  it('composes the full name when first AND last are present', () => {
    expect(
      composeDisplayName({
        name: { first: 'Jane', last: 'Doe' },
        username: 'janedoe',
        publicKey: '0x1234567890abcdef',
      })
    ).toBe('Jane Doe');
  });

  it('composes a FIRST-ONLY name (does not require both parts)', () => {
    expect(
      composeDisplayName({
        name: { first: 'Cher' },
        username: 'mononym',
      })
    ).toBe('Cher');
  });

  it('composes a LAST-ONLY name', () => {
    expect(
      composeDisplayName({
        name: { last: 'Prince' },
        username: 'theartist',
      })
    ).toBe('Prince');
  });

  it('prefers an explicit name.displayName (trimmed) over a composed full name', () => {
    expect(
      composeDisplayName({
        name: { first: 'Jane', last: 'Doe', displayName: '  Janey  ' },
      })
    ).toBe('Janey');
  });

  it('returns undefined when there is no usable name (username is NOT a fallback)', () => {
    expect(
      composeDisplayName({
        name: { first: '', last: '' },
        username: 'fallbackuser',
        publicKey: '0x1234567890abcdef',
      })
    ).toBeUndefined();
  });

  it('returns undefined when the name subdocument is absent (username only)', () => {
    expect(composeDisplayName({ username: 'noname' })).toBeUndefined();
  });

  it('returns undefined for a publicKey-only user (no handle synthesis)', () => {
    expect(
      composeDisplayName({
        publicKey: '0x1234567890abcdef1234567890abcdef',
      })
    ).toBeUndefined();
  });

  it('returns undefined when name, username, and publicKey are all absent', () => {
    expect(composeDisplayName({})).toBeUndefined();
  });

  it('prefers the name even when a username is also present (name wins)', () => {
    expect(
      composeDisplayName({
        name: { first: 'Ada', last: 'Lovelace' },
        username: 'ada',
      })
    ).toBe('Ada Lovelace');
  });
});

describe('composeFullName', () => {
  it('joins first and last', () => {
    expect(composeFullName({ first: 'Jane', last: 'Doe' })).toBe('Jane Doe');
  });

  it('returns first-only without requiring last', () => {
    expect(composeFullName({ first: 'Cher' })).toBe('Cher');
  });

  it('returns an empty string when both parts are empty', () => {
    expect(composeFullName({ first: '', last: '' })).toBe('');
  });

  it('returns an empty string for a missing name', () => {
    expect(composeFullName(undefined)).toBe('');
    expect(composeFullName(null)).toBe('');
  });
});

describe('formatUserNameResponse', () => {
  it('emits full and displayName for structured names', () => {
    expect(
      formatUserNameResponse({
        name: { first: 'Jane', last: 'Doe' },
        username: 'janedoe',
      })
    ).toEqual({
      first: 'Jane',
      last: 'Doe',
      full: 'Jane Doe',
      displayName: 'Jane Doe',
    });
  });

  it('OMITS displayName (and first/last/full) for a username-only user', () => {
    expect(
      formatUserNameResponse({
        name: { first: '', last: '' },
        username: 'janedoe',
      })
    ).toEqual({});
  });

  it('OMITS displayName for a publicKey-only user (no synthesis)', () => {
    expect(
      formatUserNameResponse({
        publicKey: '0x1234567890abcdef',
      })
    ).toEqual({});
  });

  it('emits a first-only displayName/full without a last name', () => {
    expect(
      formatUserNameResponse({
        name: { first: 'Cher' },
        username: 'mononym',
      })
    ).toEqual({ first: 'Cher', full: 'Cher', displayName: 'Cher' });
  });
});

describe('truncatePublicKeyHandle', () => {
  it('keeps the 0x prefix and truncates the middle', () => {
    expect(truncatePublicKeyHandle('0x1234567890abcdef1234567890abcdef')).toBe('0x123456...abcdef');
  });

  it('truncates a bare hex key without a prefix', () => {
    expect(truncatePublicKeyHandle('abcdef1234567890fedcba')).toBe('abcdef...fedcba');
  });

  it('returns undefined for a missing key', () => {
    expect(truncatePublicKeyHandle(undefined)).toBeUndefined();
    expect(truncatePublicKeyHandle(null)).toBeUndefined();
    expect(truncatePublicKeyHandle('')).toBeUndefined();
  });
});

describe('resolveEmailFromName', () => {
  it('uses composed real name when present', () => {
    expect(
      resolveEmailFromName({
        name: { first: 'Jane', last: 'Doe' },
        username: 'janed',
      }),
    ).toBe('Jane Doe');
  });

  it('falls back to username when no real name exists', () => {
    expect(resolveEmailFromName({ username: 'janed' })).toBe('janed');
  });

  it('prefers explicit displayName over username', () => {
    expect(
      resolveEmailFromName({
        name: { displayName: 'Jane' },
        username: 'janed',
      }),
    ).toBe('Jane');
  });
});
