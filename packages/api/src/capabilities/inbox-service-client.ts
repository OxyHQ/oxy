import { OxyServer } from '@oxy.so/core/server';

let client: OxyServer | null | undefined;

export function inboxServiceClient(): OxyServer | null {
  if (client !== undefined) return client;
  const key = process.env.INBOX_APPLICATION_KEY?.trim();
  const secret = process.env.INBOX_APPLICATION_SECRET?.trim();
  if (!key || !secret) {
    client = null;
    return client;
  }
  const baseURL = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');
  client = new OxyServer({ baseURL, serviceAuth: { apiKey: key, apiSecret: secret } });
  return client;
}

export function requiredInboxServiceClient(): OxyServer {
  const configured = inboxServiceClient();
  if (!configured) throw new Error('Inbox application credentials are not configured');
  return configured;
}
