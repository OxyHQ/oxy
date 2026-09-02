import { OxyServices } from '@oxyhq/core';

let client: OxyServices | null | undefined;

export function inboxServiceClient(): OxyServices | null {
  if (client !== undefined) return client;
  const key = process.env.INBOX_APPLICATION_KEY?.trim();
  const secret = process.env.INBOX_APPLICATION_SECRET?.trim();
  if (!key || !secret) {
    client = null;
    return client;
  }
  const baseURL = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');
  client = new OxyServices({ baseURL });
  client.configureServiceAuth(key, secret);
  return client;
}

export function requiredInboxServiceClient(): OxyServices {
  const configured = inboxServiceClient();
  if (!configured) throw new Error('Inbox application credentials are not configured');
  return configured;
}
