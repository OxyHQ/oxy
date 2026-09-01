import { COMMONS_DENY_REASONS, commonsDenyReasonSchema } from '../index';

/**
 * The closed denial set for `POST /auth/session/deny/:authorizeCode`.
 *
 * It is enforced in three places — the API request schema, the Mongoose `enum`
 * of `AuthSession.deniedReason`, and the SDK's `denyCommonsSignIn` parameter —
 * and all three read THIS declaration. The endpoint is unauthenticated, so the
 * set widening by accident is not a cosmetic problem: it would let an
 * unauthenticated caller write arbitrary text onto a record other surfaces read.
 * These tests pin the exact membership and the rejection of everything else.
 */
describe('commonsDenyReasonSchema', () => {
    it('is exactly { declined, not_me }', () => {
        expect([...COMMONS_DENY_REASONS]).toEqual(['declined', 'not_me']);
        expect(commonsDenyReasonSchema.options).toEqual([...COMMONS_DENY_REASONS]);
    });

    it.each([...COMMONS_DENY_REASONS])('accepts %s', (reason) => {
        expect(commonsDenyReasonSchema.parse(reason)).toBe(reason);
    });

    it.each([
        ['free-form text', 'the app looked phishy'],
        ['an out-of-set value', 'suspicious'],
        ['an empty string', ''],
        ['a differently-cased member', 'Declined'],
        ['a non-string', 42],
        ['null', null],
        ['undefined', undefined],
        ['an object', { reason: 'not_me' }],
    ])('rejects %s', (_label, value) => {
        expect(commonsDenyReasonSchema.safeParse(value).success).toBe(false);
    });
});
