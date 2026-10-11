import { OxyServer, canAttestWorkloadIdentity } from '@oxy.so/core/server';

/**
 * How this process acts as the Oxy Inbox application, decided ONCE for every
 * Inbox caller — the outbox worker, the catalog registration and point
 * inference all ask this, so removing the key pair cannot switch one of them
 * to the task role while another still refuses for want of a key.
 *
 *   * A full `INBOX_APPLICATION_KEY`/`INBOX_APPLICATION_SECRET` pair wins. A
 *     deployment that still carries one keeps using it, exactly as before.
 *   * No pair at all, on a host that can attest: the task role, whose binding
 *     to Inbox names the authority (ADR 0026). There is nothing to configure.
 *   * HALF a pair is refused, never read as "no pair". It means somebody meant
 *     to configure a credential and did not finish, and quietly acting as the
 *     task role instead would be a different identity than the one intended.
 *   * Neither: no Inbox identity here, which is the honest answer on a laptop.
 */
export type InboxServiceIdentity =
  | { readonly kind: 'credential'; readonly apiKey: string; readonly apiSecret: string }
  | { readonly kind: 'workload' }
  | { readonly kind: 'none'; readonly reason: 'half_pair' | 'no_identity' };

export function inboxServiceIdentity(env: NodeJS.ProcessEnv = process.env): InboxServiceIdentity {
  const apiKey = env.INBOX_APPLICATION_KEY?.trim();
  const apiSecret = env.INBOX_APPLICATION_SECRET?.trim();
  if (apiKey && apiSecret) return { kind: 'credential', apiKey, apiSecret };
  if (apiKey || apiSecret) return { kind: 'none', reason: 'half_pair' };
  return canAttestWorkloadIdentity(env)
    ? { kind: 'workload' }
    : { kind: 'none', reason: 'no_identity' };
}

let client: OxyServer | null | undefined;

export function inboxServiceClient(): OxyServer | null {
  if (client !== undefined) return client;
  const identity = inboxServiceIdentity();
  if (identity.kind === 'none') {
    client = null;
    return client;
  }
  const baseURL = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');
  // Without `serviceAuth`, `serviceToken()` attests the task role and the mint
  // answers with whatever the role's binding names — the same token, the same
  // hour, `credentialId` the binding's `wl_…` handle.
  client =
    identity.kind === 'credential'
      ? new OxyServer({
          baseURL,
          serviceAuth: { apiKey: identity.apiKey, apiSecret: identity.apiSecret },
        })
      : new OxyServer({ baseURL });
  return client;
}

export function requiredInboxServiceClient(): OxyServer {
  const configured = inboxServiceClient();
  if (!configured) throw new Error('Inbox application identity is not available');
  return configured;
}
