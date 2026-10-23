import type { ServiceLane } from '../client/context';

/** The existing external MCP media action, never an own requester/session proof. */
export interface ExternalMcpMediaProof {
  connectionToken: string;
  tool: 'upload-media' | 'upload-media-from-url';
  accountId?: string;
}
export function bindExternalMcpMediaLane(
  original: ServiceLane,
  proof: ExternalMcpMediaProof,
): ServiceLane {
  const { connectionToken, tool, accountId } = proof;
  if (
    !connectionToken ||
    connectionToken.length > 16384 ||
    /\s/.test(connectionToken) ||
    (tool !== 'upload-media' && tool !== 'upload-media-from-url') ||
    (accountId !== undefined && (!accountId || /\s/.test(accountId)))
  )
    throw new Error('A connection token and its existing media tool are required');
  return {
    get available() {
      return original.available;
    },
    request: (method, url, data, options) => {
      const allowed =
        tool === 'upload-media'
          ? method === 'POST' && url === '/assets/service/user-media'
          : (method === 'POST' && url === '/assets/service/user-media/import') ||
            (method === 'GET' && /^\/assets\/service\/user-media\/imports\/[^/?#]+$/.test(url));
      if (!allowed)
        return Promise.reject(
          new Error('The external MCP proof is limited to its media operation'),
        );
      const headers = { ...options?.headers };
      for (const key of Object.keys(headers))
        if (
          [
            'x-oxy-user-id',
            'x-oxy-task-id',
            'x-oxy-requester-token',
            'x-oxy-capability-ticket',
            'x-oxy-mcp-media-token',
            'x-oxy-mcp-media-tool',
          ].includes(key.toLowerCase())
        )
          delete headers[key];
      headers['X-Oxy-Mcp-Media-Token'] = connectionToken;
      headers['X-Oxy-Mcp-Media-Tool'] = tool;
      if (accountId) headers['X-Oxy-User-Id'] = accountId;
      return original.request(method, url, data, {
        ...options,
        headers,
        cache: false,
        deduplicate: false,
        retry: false,
      });
    },
  };
}
