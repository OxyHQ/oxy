import { identityOriginHeaders, resolveApiOrigin, withIdentityHeaders } from './headers.mjs';

export default {
  async fetch(request, env) {
    const headers = identityOriginHeaders({ apiOrigin: resolveApiOrigin(env.OXY_API_ORIGIN) });
    return withIdentityHeaders(await env.ASSETS.fetch(request), headers);
  },
};
