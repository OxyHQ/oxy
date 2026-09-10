import { INBOX_CAPABILITY_CATALOG } from '../src/capabilities/inbox.catalog';
import { requiredInboxServiceClient } from '../src/capabilities/inbox-service-client';

async function main(): Promise<void> {
  const apiUrl = process.env.OXY_API_URL ?? 'https://api.oxy.so';
  const token = await requiredInboxServiceClient().getServiceToken();

  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/capabilities/catalogs/register`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ catalog: INBOX_CAPABILITY_CATALOG, deployedAt: new Date().toISOString() }),
  });
  if (!response.ok) {
    throw new Error(`Catalog registration failed (${response.status}): ${await response.text()}`);
  }
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
