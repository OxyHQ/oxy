import { registerCapabilityCatalog } from '@oxy.so/mcp';
import { INBOX_CAPABILITY_CATALOG } from '../src/capabilities/inbox.catalog';
import { requiredInboxServiceClient } from '../src/capabilities/inbox-service-client';

export async function main(): Promise<void> {
  const apiUrl = process.env.OXY_API_URL ?? 'https://api.oxy.so';
  const client = requiredInboxServiceClient();
  const transport = client.createServiceClient({ baseURL: apiUrl, audience: 'oxy-api' });
  try {
    const binding = await registerCapabilityCatalog(INBOX_CAPABILITY_CATALOG, {
      oxyApiUrl: apiUrl,
      transport,
    });
    process.stdout.write(`${JSON.stringify(binding, null, 2)}\n`);
  } finally {
    transport.dispose();
    client.dispose();
  }
}
if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
