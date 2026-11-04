import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

/** Inbox runs in this process: infrastructure proves its identity, never a customer key.
 * The shared provider resolves temporary ECS/assumed-role/SSO credentials lazily.
 * Account and event-source ownership remain separate checks at the destination.
 */
let client: OxyServer | undefined;

export function inboxServiceClient(): OxyServer {
  if (process.env.INBOX_APPLICATION_KEY?.trim() || process.env.INBOX_APPLICATION_SECRET?.trim())
    throw new Error(
      'Inbox uses workload identity; remove INBOX_APPLICATION_KEY and INBOX_APPLICATION_SECRET.',
    );
  client ??= new OxyServer({
    baseURL: (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, ''),
    workloadCredentials: createAwsWorkloadCredentialProvider(),
  });
  return client;
}

export const requiredInboxServiceClient = inboxServiceClient;
