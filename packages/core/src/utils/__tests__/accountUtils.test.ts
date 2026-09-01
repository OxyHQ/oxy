import {
    createQuickAccount,
    getAccountDisplayName,
    getAccountFallbackHandle,
    formatPublicKeyHandle,
} from '../accountUtils';

describe('getAccountDisplayName', () => {
    it('prefers the API name.displayName when present', () => {
        expect(
            getAccountDisplayName({
                name: { first: 'Nate', displayName: 'Nate Isern' },
                username: 'nateus',
            }),
        ).toBe('Nate Isern');
    });

    it('returns first name for first-name-only accounts (NOT the username)', () => {
        const result = getAccountDisplayName({
            name: { first: 'Nate' },
            username: 'nateus',
        });
        expect(result).toBe('Nate');
        expect(result).not.toBe('nateus');
    });

    it('composes first + last when both are present', () => {
        expect(
            getAccountDisplayName({
                name: { first: 'Nate', last: 'Isern' },
                username: 'nateus',
            }),
        ).toBe('Nate Isern');
    });

    it('returns last name only when first is missing', () => {
        expect(
            getAccountDisplayName({
                name: { last: 'Isern' },
                username: 'nateus',
            }),
        ).toBe('Isern');
    });

    it('prefers name.full when present', () => {
        expect(
            getAccountDisplayName({
                name: { first: 'Nate', last: 'Isern', full: 'Nathaniel Isern' },
                username: 'nateus',
            }),
        ).toBe('Nathaniel Isern');
    });

    it('uses pre-normalized account-row displayName when there is no structured name', () => {
        expect(
            getAccountDisplayName({
                displayName: 'Cool Display',
                username: 'nateus',
            }),
        ).toBe('Cool Display');
    });

    it('supports name stored as a plain string', () => {
        expect(getAccountDisplayName({ name: 'Legacy Name', username: 'nateus' })).toBe(
            'Legacy Name',
        );
    });

    it('falls back to username when there is no name', () => {
        expect(getAccountDisplayName({ username: 'nateus' })).toBe('nateus');
    });

    it('falls back to the public-key handle when there is no name or username', () => {
        const result = getAccountDisplayName({
            publicKey: '0x1234567890abcdef',
        });
        // common.accountFallback = "Account {{handle}}"; handle truncated to 0x12345678…
        expect(result).toBe('Account 0x12345678…');
        expect(result).not.toContain('Unknown');
    });

    it('returns the translated unnamed fallback when nothing is available', () => {
        expect(getAccountDisplayName({})).toBe('Unnamed');
        expect(getAccountDisplayName(null)).toBe('Unnamed');
        expect(getAccountDisplayName(undefined)).toBe('Unnamed');
    });

    it('ignores whitespace-only name fields', () => {
        expect(
            getAccountDisplayName({
                name: { first: '   ', last: '   ' },
                username: 'nateus',
            }),
        ).toBe('nateus');
    });

    it('honours the locale for the fallback strings', () => {
        expect(getAccountDisplayName({}, 'es-ES')).toBe('Sin nombre');
        expect(getAccountDisplayName({ publicKey: '0x1234567890abcdef' }, 'es-ES')).toBe(
            'Cuenta 0x12345678…',
        );
    });
});

describe('getAccountFallbackHandle', () => {
    it('returns the bare username when present', () => {
        expect(getAccountFallbackHandle({ username: 'nateus' })).toBe('nateus');
    });

    it('falls back to a truncated public-key handle', () => {
        expect(getAccountFallbackHandle({ publicKey: '0x1234567890abcdef' })).toBe('0x12345678…');
    });

    it('returns undefined when neither username nor publicKey is present', () => {
        expect(getAccountFallbackHandle({})).toBeUndefined();
        expect(getAccountFallbackHandle(null)).toBeUndefined();
    });
});

describe('createQuickAccount', () => {
    it('prefers API name.displayName over composed first/last', () => {
        const account = createQuickAccount('sess-1', {
            name: { first: 'Nate', last: 'Isern', displayName: 'Nate Isern' },
            username: 'nateus',
            id: 'user-1',
        });
        expect(account.displayName).toBe('Nate Isern');
    });

    it('falls back to the normalized handle when displayName is absent', () => {
        const account = createQuickAccount('sess-1', {
            name: { first: 'Nate', last: 'Isern' },
            username: 'nateus',
            id: 'user-1',
        });
        expect(account.displayName).toBe('nateus');
        expect(account.displayName).not.toBe('Nate Isern');
    });
});

describe('formatPublicKeyHandle', () => {
    it('truncates a long key and strips the 0x prefix before re-adding it', () => {
        expect(formatPublicKeyHandle('0x1234567890abcdef')).toBe('0x12345678…');
        expect(formatPublicKeyHandle('1234567890abcdef')).toBe('0x12345678…');
    });

    it('returns the raw (prefixed) key when too short to truncate', () => {
        expect(formatPublicKeyHandle('0xabcd')).toBe('0xabcd');
        expect(formatPublicKeyHandle('abcd')).toBe('0xabcd');
    });
});
