/**
 * `@oxy.so/core/inference` — the Oxy inference client.
 *
 * Its own subpath so an app that never calls inference never bundles it.
 *
 * ```ts
 * import { createInferenceClient } from '@oxy.so/core/inference';
 * const inference = createInferenceClient(oxy); // the session's bearer
 * ```
 *
 * A server holding an Oxy API key builds `new OxyInferenceClient({ credential })`
 * directly — one surface, two credential lanes. See `docs/inference/sdk.md`.
 */
import type { OxyServices } from '../OxyServices';
import { OxyInferenceClient, type OxyInferenceClientOptions } from './OxyInferenceClient';

export {
  OXY_INFERENCE_BASE_URL,
  OxyInferenceClient,
  OxyInferenceError,
  OxyInferenceProtocolError,
} from './OxyInferenceClient';
export type {
  OxyGenerationReceipt,
  OxyInferenceClientOptions,
  OxyInferenceCredential,
  OxyInferenceFetch,
  OxyInferenceRequestOptions,
  OxyInferenceResponse,
  OxyResponsesRequest,
  OxySpeechRequest,
  OxySpeechResponse,
} from './OxyInferenceClient';

/**
 * An inference client bound to `oxy`'s session: it calls the same API origin
 * with the session's current bearer on every request.
 */
export function createInferenceClient(
  oxy: OxyServices,
  options: Omit<OxyInferenceClientOptions, 'baseURL' | 'credential'> = {},
): OxyInferenceClient {
  return new OxyInferenceClient({
    ...options,
    baseURL: oxy.baseURL,
    credential: () => oxy.session.accessToken,
  });
}
