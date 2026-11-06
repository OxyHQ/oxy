import type { PostalAddress, PostalAddressInput, PostalAddressUpdate } from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';

/** Private postal destinations belonging to the currently authenticated account. */
export class AddressesApi {
  constructor(private readonly ctx: OxyContext) {}
  list(): Promise<PostalAddress[]> {
    return this.ctx.request('GET', '/addresses', undefined, { cache: false });
  }
  create(input: PostalAddressInput): Promise<PostalAddress> {
    return this.ctx.request('POST', '/addresses', input, { cache: false });
  }
  update(id: string, input: PostalAddressUpdate): Promise<PostalAddress> {
    return this.ctx.request('PATCH', `/addresses/${encodeURIComponent(id)}`, input, {
      cache: false,
    });
  }
  delete(id: string): Promise<void> {
    return this.ctx.request('DELETE', `/addresses/${encodeURIComponent(id)}`, undefined, {
      cache: false,
    });
  }
}
