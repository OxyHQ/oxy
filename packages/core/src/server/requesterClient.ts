import { OxyServices } from '../OxyServices';
import type { HttpMethod, ServiceLane } from '../client/context';
import type { RequestOptions, ResponsePayload } from '../HttpService';
import { ServerAssetsApi } from './namespaces';
import { bindRequesterLane, type RequesterProof } from './requesterContext';

/** Oxy namespaces bound to one verified requester, without sharing mutable auth state. */
export class OxyRequesterClient extends OxyServices {
  private readonly requesterLane: ServiceLane;
  private requesterAssets?: ServerAssetsApi;
  constructor(baseURL: string, cloudURL: string, original: ServiceLane, proof: RequesterProof) {
    super({ baseURL, cloudURL });
    this.requesterLane = bindRequesterLane(original, proof);
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
    if (!this.requesterAssets) this.requesterAssets = new ServerAssetsApi(this.context);
    return this.requesterAssets;
  }
}
