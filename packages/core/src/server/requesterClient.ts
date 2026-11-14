import { OxyServices } from '../OxyServices';
import type { HttpMethod, ServiceLane } from '../client/context';
import type { RequestOptions, ResponsePayload } from '../HttpService';
import { ServerAssetsApi } from './namespaces';

/**
 * Oxy namespaces bound to one account (`actingFor`, ADR 0066) or one requester
 * proof, without sharing mutable auth state. The lane arrives already bound.
 */
export class OxyRequesterClient extends OxyServices {
  private readonly requesterLane: ServiceLane;
  constructor(baseURL: string, cloudURL: string, bound: ServiceLane) {
    super({ baseURL, cloudURL });
    this.requesterLane = bound;
    this.context.service = this.requesterLane;
  }
  override request<T>(
    method: HttpMethod,
    url: string,
    data?: unknown,
    options?: RequestOptions,
  ): Promise<ResponsePayload<T>> {
    return this.requesterLane.request(method, url, data, options);
  }
  override get assets(): ServerAssetsApi {
    return this.namespace('assets', (context) => new ServerAssetsApi(context));
  }
}
