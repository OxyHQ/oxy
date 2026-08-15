/**
 * The inference model catalogue — the only inference surface an SDK consumer
 * can call today (issue #972, workstream 15).
 *
 * ## What is deliberately NOT here
 *
 * There are no methods for sending an inference request, streaming one,
 * cancelling one, or reading a usage receipt, because **no such endpoint
 * exists**. `POST /v1/chat/completions` is the pre-existing static-`ALIA_API_KEY`
 * proxy to Alia and is restricted to callers acting for a platform-trusted
 * first-party application (`packages/api/src/routes/alia.ts`); `POST /v1/responses`,
 * `GET /v1/models` and `GET /v1/generations/:id` do not exist at all. A method
 * that 404s is a worse artifact than an absent one: it turns "not built yet"
 * into a runtime failure a consumer has to debug. Workstream 4 builds that edge,
 * and the client for it lands with it.
 *
 * The status board naming every one of those gaps is `docs/inference/README.md`.
 *
 * ## Types come from `@oxyhq/contracts`, including the model-id grammar
 *
 * `ModelCatalogueEntry` and `RoutingProfile` are `z.infer<>` of the schemas the
 * API itself serves through, so the wire shape has exactly one declaration. The
 * `<publisher>/<model>` grammar comes from `modelIdSchema` for the same reason:
 * {@link OxyServicesInferenceMixin.getInferenceModel} has to split a canonical id
 * into two path segments, and a second copy of "how many slashes an id has"
 * would be a rule that could drift from the one the server validates against.
 *
 * Responses are typed, not re-parsed. The server already validates every entry
 * against `modelCatalogueEntrySchema` before serving it, and a second
 * client-side `parse` of a non-strict object schema would silently DROP fields a
 * newer API added — turning forward compatibility into data loss. The
 * device-token mint parses because a forged mint response is a security
 * question; a catalogue read is not.
 *
 * ## Caching
 *
 * These are ordinary GETs, so the SDK's per-instance GET cache applies. That is
 * correct here even though the catalogue is audience-scoped: cache keys are
 * identity-tagged (`HttpService.generateCacheKey`), so a change of principal
 * cannot serve one audience's catalogue to another.
 */

import { modelIdSchema } from '@oxyhq/contracts';
import type { ModelCatalogueEntry, RoutingProfile } from '@oxyhq/contracts';
import type { OxyServicesBase } from '../OxyServices.base';

/** Envelope of `GET /models` and `GET /models/routing-profiles`. */
interface CatalogueCollectionResponse<T> {
  data: T[];
  count: number;
}

/** Envelope of `GET /models/:publisher/:model`. */
interface CatalogueEntryResponse {
  data: ModelCatalogueEntry;
}

export function OxyServicesInferenceMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    /**
     * The models this caller may use, as the customer-safe catalogue projection.
     *
     * Audience-scoped server-side: an anonymous caller, a user bearer and an
     * ordinary application's service token all see the PUBLIC catalogue; only an
     * internal/system application sees internal-only routes. The SDK sends no
     * audience of its own — whatever bearer the session holds is the audience.
     *
     * **An empty array is a normal answer.** The catalogue is populated by
     * operators through the staff admin surface, and until a route has an
     * approved commercial permission it is not publicly exposed. Callers must
     * render "no models available" rather than treating `[]` as an error.
     */
    async listInferenceModels(): Promise<ModelCatalogueEntry[]> {
      try {
        const res = await this.makeRequest<CatalogueCollectionResponse<ModelCatalogueEntry>>(
          'GET',
          '/models',
        );
        return res.data;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * One catalogue entry by its canonical id, `<publisher>/<model>`.
     *
     * The id is two URL path segments, not one, because a canonical model id
     * CONTAINS a slash and a single encoded segment would never match the route.
     *
     * A model the caller may not see answers 404 identically to one that does
     * not exist — deliberately, so the catalogue is never an existence oracle
     * for what Oxy runs internally. Both surface here as a thrown error.
     *
     * @param modelId - `<publisher>/<model>`, e.g. `openai/gpt-5`. A revision
     *   pin (`<publisher>/<model>@<revision>`) names a model REFERENCE, not a
     *   model, and is rejected here rather than sent — the catalogue is keyed on
     *   models, and a pinned reference would 404 in a way indistinguishable from
     *   "no such model".
     */
    async getInferenceModel(modelId: string): Promise<ModelCatalogueEntry> {
      const parsed = modelIdSchema.safeParse(modelId);
      if (!parsed.success) {
        throw new Error(
          `Not a canonical model id: ${modelId}. Expected <publisher>/<model>, e.g. openai/gpt-5.`,
        );
      }

      const [publisher, model] = parsed.data.split('/');
      try {
        const res = await this.makeRequest<CatalogueEntryResponse>(
          'GET',
          `/models/${encodeURIComponent(publisher)}/${encodeURIComponent(model)}`,
        );
        return res.data;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * The routing profiles this caller may select.
     *
     * A routing profile (`auto`, `fast`, `quality`) is a named strategy for
     * CHOOSING among routes. It is not a model: it has no publisher, no
     * revision, no license and no weights, and its slug can never be written as
     * `<publisher>/<model>`. That separation is what keeps "did I ask for a
     * concrete model or for Oxy to choose one" decidable — see ADR 0008.
     *
     * Like the model list, an empty array is a normal answer.
     */
    async listInferenceRoutingProfiles(): Promise<RoutingProfile[]> {
      try {
        const res = await this.makeRequest<CatalogueCollectionResponse<RoutingProfile>>(
          'GET',
          '/models/routing-profiles',
        );
        return res.data;
      } catch (error) {
        throw this.handleError(error);
      }
    }
  };
}
