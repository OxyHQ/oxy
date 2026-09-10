import { z } from 'zod';
import {
  mcpConnectionStateSchema,
  type McpConnectionState,
} from './oauth';
import {
  postOxyServiceJson,
  type OxyMcpServiceRequestOptions,
} from './serviceRequest';

/**
 * Connection-level calls a resource server makes on behalf of a live token.
 *
 * These are the two things a person can ask their assistant for once a
 * connector exists: "connect another account" and "act as that one instead".
 * Both are decided by Oxy — the resource server only presents the token it is
 * serving and relays the answer.
 */

const accountLinkSchema = z.object({
  link_url: z.url(),
  expires_in: z.number().int().positive(),
  connection_id: z.string().trim().min(1),
});

export type OxyMcpAccountLink = z.infer<typeof accountLinkSchema>;

/**
 * Ask Oxy for the URL a person opens to add ANOTHER account to this connection.
 *
 * The URL is single-use and short-lived, and it never selects an account: which
 * account joins is decided on the IdP by whoever approves it there, signed in
 * as that account.
 */
export async function requestOxyMcpAccountLink(
  token: string,
  options: OxyMcpServiceRequestOptions,
): Promise<OxyMcpAccountLink> {
  if (!token.trim()) throw new Error('An MCP access token is required to request an account link');
  return accountLinkSchema.parse(await postOxyServiceJson({ token }, options));
}

/**
 * Point the connection at one of its member accounts.
 *
 * Oxy refuses an account that is not a live member, or whose approver can no
 * longer operate it, so a switch cannot outlive the consent behind it.
 */
export async function selectOxyMcpConnectionAccount(
  input: { token: string; accountId: string },
  options: OxyMcpServiceRequestOptions,
): Promise<McpConnectionState> {
  if (!input.token.trim()) throw new Error('An MCP access token is required to switch account');
  if (!input.accountId.trim()) throw new Error('An account id is required to switch account');
  const body = await postOxyServiceJson(
    { token: input.token, account_id: input.accountId },
    options,
  );
  return z.object({ connection: mcpConnectionStateSchema }).parse(body).connection;
}
