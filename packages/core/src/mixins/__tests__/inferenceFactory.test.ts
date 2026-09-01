/**
 * `oxyServices.inference()` — the binding, which is the only thing this mixin
 * does.
 *
 * Two properties matter and neither is visible from the client's own suite: the
 * client must inherit THIS instance's base URL, and it must read the bearer
 * LATE, so a token planted after construction is the one that gets sent. A
 * factory that captured `getAccessToken()` eagerly would pass every test that
 * signs in first and fail on the cold-boot ordering every app actually has.
 *
 * Driven through the real global `fetch`, spied — the factory takes no
 * transport, so a test that built its own client would be asserting against a
 * re-implementation of the thing under test rather than against it.
 */

import { OxyServices } from '../../OxyServices';
import { OxyInferenceClient } from '../../inference/OxyInferenceClient';

describe('OxyServices.inference()', () => {
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
        fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ data: [], count: 0 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    it('returns one memoized client, so a consumer can hold it', () => {
        const oxy = new OxyServices({ baseURL: 'http://test.invalid' });

        const first = oxy.inference();
        expect(first).toBeInstanceOf(OxyInferenceClient);
        expect(oxy.inference()).toBe(first);
    });

    it('binds this instance base URL and reads the bearer at request time', async () => {
        const oxy = new OxyServices({ baseURL: 'http://test.invalid' });
        const client = oxy.inference();

        // The token is planted AFTER the client exists — the cold-boot order.
        oxy.setTokens('planted-later');
        await client.listModels();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(String(url)).toBe('http://test.invalid/v1/models');
        expect((init.headers as Record<string, string>)['Authorization']).toBe(
            'Bearer planted-later',
        );
    });
});
