import { isHttpRequestError, parseHttpErrorBody } from '../utils/errorUtils';

/**
 * `parseHttpErrorBody` is the ONE place the SDK decides what a failed request's
 * message, code and details are, across every error envelope the Oxy ecosystem
 * emits. The bug it exists to prevent is silent: a nested
 * `{ error: { code, message } }` assigned straight to `new Error(...)` yields
 * the literal string `"[object Object]"`, which reads as a rendering bug in
 * whichever app surfaces it, arbitrarily far from here.
 *
 * Each case below pins one envelope AND the discrimination it depends on — in
 * particular, whether the top-level `error` string is a machine CODE or human
 * prose is decided solely by whether a sibling human field is present, so both
 * sides of that fork need a fixture or the rule is untested.
 */
describe('parseHttpErrorBody', () => {
    it('reads the nested { error: { code, message, details } } envelope', () => {
        expect(
            parseHttpErrorBody({
                error: { code: 'case_conflict', message: 'A case already exists', details: { caseId: 'c_1' } },
            }),
        ).toEqual({
            message: 'A case already exists',
            code: 'case_conflict',
            details: { caseId: 'c_1' },
        });
    });

    it("reads oxy-api's { error: '<CODE>', message } shape — error IS the code", () => {
        expect(parseHttpErrorBody({ error: 'VALIDATION_ERROR', message: 'username is taken' })).toEqual({
            message: 'username is taken',
            code: 'VALIDATION_ERROR',
            details: undefined,
        });
    });

    it("reads RFC 6749 { error: '<CODE>', error_description } from the OAuth endpoints", () => {
        // The OAuth token/userinfo endpoints are the one part of the API that
        // does not use the `{ error, message }` envelope. Without this arm the
        // human text is dropped and the raw code is shown to the user.
        expect(
            parseHttpErrorBody({ error: 'invalid_grant', error_description: 'Authorization code expired' }),
        ).toEqual({
            message: 'Authorization code expired',
            code: 'invalid_grant',
            details: undefined,
        });
    });

    it("treats a LONE { error: '<text>' } as the message, never as a code", () => {
        // The discriminator is the ABSENCE of a sibling human field. Promoting a
        // bare string to `code` would put prose where callers switch on codes,
        // so this case and the two above have to disagree.
        expect(parseHttpErrorBody({ error: 'Something went wrong' })).toEqual({
            message: 'Something went wrong',
            code: undefined,
            details: undefined,
        });
    });

    it('reads the flat { message, code } shape (CSRF rejections)', () => {
        expect(parseHttpErrorBody({ message: 'Invalid CSRF token', code: 'CSRF_TOKEN_INVALID' })).toEqual({
            message: 'Invalid CSRF token',
            code: 'CSRF_TOKEN_INVALID',
            details: undefined,
        });
    });

    it('ignores whitespace-only strings rather than reporting them as a message', () => {
        // A blank message is worse than none: it replaces the status fallback
        // with an empty error surface the user cannot act on.
        expect(parseHttpErrorBody({ message: '   ', error: '' })).toEqual({
            message: undefined,
            code: undefined,
            details: undefined,
        });
    });

    it('ignores a non-object `details` instead of passing it through', () => {
        expect(parseHttpErrorBody({ message: 'nope', details: 'not-an-object' }).details).toBeUndefined();
        expect(parseHttpErrorBody({ message: 'nope', details: ['a'] }).details).toBeUndefined();
    });

    it.each([null, undefined, [], 'a string', 42, true])('returns {} for the non-object body %p', (body) => {
        expect(parseHttpErrorBody(body)).toEqual({});
    });

    it('returns {} for an object carrying none of the known fields', () => {
        expect(parseHttpErrorBody({ unrelated: 'field' })).toEqual({
            message: undefined,
            code: undefined,
            details: undefined,
        });
    });
});

describe('isHttpRequestError', () => {
    it('accepts an Error carrying a numeric status', () => {
        const error = Object.assign(new Error('boom'), { status: 409 });
        expect(isHttpRequestError(error)).toBe(true);
    });

    it('rejects a plain ApiError object — those are objects, not Errors', () => {
        // The distinction is load-bearing: an ApiError has to go through
        // `handleHttpError` first, and a truthy answer here would let a caller
        // read `.stack`/`.name` off something that has neither.
        expect(isHttpRequestError({ message: 'boom', status: 409, code: 'CONFLICT' })).toBe(false);
    });

    it('rejects an Error whose status is a non-number', () => {
        // `'409'` is the shape a hand-built error most plausibly carries, and
        // the narrowing promises callers a number they can compare.
        expect(isHttpRequestError(Object.assign(new Error('boom'), { status: '409' }))).toBe(false);
        expect(isHttpRequestError(new Error('boom'))).toBe(false);
    });
});
