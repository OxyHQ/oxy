import { INBOX_CAPABILITY_CATALOG } from '../src/capabilities/inbox.catalog';

const apiUrl = process.env.OXY_API_URL ?? 'https://api.oxy.so';
const token = process.env.OXY_CATALOG_SERVICE_TOKEN;
if (!token) throw new Error('OXY_CATALOG_SERVICE_TOKEN is required');

const response = await fetch(`${apiUrl.replace(/\/$/, '')}/capabilities/catalogs/register`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ catalog: INBOX_CAPABILITY_CATALOG, deployedAt: new Date().toISOString() }),
});
if (!response.ok) throw new Error(`Catalog registration failed (${response.status}): ${await response.text()}`);
process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
