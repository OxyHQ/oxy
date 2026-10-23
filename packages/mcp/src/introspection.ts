import { z } from 'zod';
import { mcpAccessTokenClaimsSchema, type McpAccessTokenClaims } from './oauth';
import {
  postOxyServiceJson,
  OxyMcpRequestError,
  type OxyMcpServiceRequestOptions,
} from './serviceRequest';

export type OxyMcpIntrospectionOptions = OxyMcpServiceRequestOptions;

/**
 * Ask Oxy for the live state of a resource-bound MCP access token.
 *
 * Results are deliberately not cached: revoking the grant, service credential,
 * account authority or catalog registration must affect the next app request.
 *
 * The returned claims carry the connection block when the connection covers
 * more than one account — read it with `mcpConnectionStateFrom` and serve
 * `active_account_id`, not `account_id`.
 */
export async function introspectOxyMcpAccessToken(
  token: string,
  options: OxyMcpIntrospectionOptions,
): Promise<McpAccessTokenClaims | null> {
  if (!token.trim()) throw new Error('MCP access token is required for introspection');
  let body: unknown;
  try {
    body = await postOxyServiceJson({ token }, options);
  } catch (error) {
    if (error instanceof OxyMcpRequestError)
      throw new Error(`Oxy MCP introspection failed (${error.status})`);
    throw error;
  }
  const envelope = z.object({ active: z.boolean() }).passthrough().parse(body);
  return envelope.active ? mcpAccessTokenClaimsSchema.parse(body) : null;
}
