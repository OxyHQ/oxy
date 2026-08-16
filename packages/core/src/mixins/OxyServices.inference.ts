/**
 * The inference API, reached with whatever bearer this session already holds
 * (issue #972, workstream 15).
 *
 * ```typescript
 * const models = await oxyServices.inference().listModels();
 * ```
 *
 * One method, and it is a FACTORY rather than a set of inference methods on
 * `OxyServices`. The calls themselves live once, in
 * {@link OxyInferenceClient} — which an external developer holding only an
 * `oxy_sk_…` machine key constructs directly, with no Oxy session anywhere in
 * the picture. Declaring the same calls a second time here would give the
 * ecosystem two spellings of one request, and only one of them would stay
 * correct.
 *
 * This is the reasoning `createLinkedClient` is already built on: the plumbing
 * that binds an Oxy bearer to a client belongs in core, once, rather than in
 * each app.
 *
 * The credential is a FUNCTION, not the current token: a session bearer rotates
 * on refresh and on account switch, and a client that captured one at
 * construction would start answering 401 an hour into the process's life.
 */

import { OxyInferenceClient } from '../inference/OxyInferenceClient';
import type { OxyServicesBase } from '../OxyServices.base';

export function OxyServicesInferenceMixin<T extends typeof OxyServicesBase>(Base: T) {
    return class extends Base {
        /** @internal Memoized so repeated calls return one object identity. */
        _inferenceClient: OxyInferenceClient | null = null;

        /**
         * The inference client for this session.
         *
         * Bound to this instance's base URL and to `getAccessToken()`, so it
         * follows every refresh, sign-in and account switch without being
         * rebuilt.
         *
         * A service-authenticated process wants a different credential and
         * builds {@link OxyInferenceClient} directly:
         * `new OxyInferenceClient({ credential: () => oxy.getServiceToken() })`.
         * The mint is asynchronous and cached, which is exactly what a
         * credential function is for.
         */
        inference(): OxyInferenceClient {
            if (this._inferenceClient === null) {
                this._inferenceClient = new OxyInferenceClient({
                    baseURL: this.getBaseURL(),
                    credential: () => this.getAccessToken(),
                });
            }
            return this._inferenceClient;
        }
    };
}
