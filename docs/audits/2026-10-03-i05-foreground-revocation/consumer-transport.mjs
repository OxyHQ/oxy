import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { OxyServer as ESMServer } from '@oxy.so/core/server';
import { foregroundExecutionAuthorizationInputSchema as esmSchema } from '@oxy.so/contracts';
const { OxyServer: CJSServer } = createRequire(import.meta.url)('@oxy.so/core/server');
const { foregroundExecutionAuthorizationInputSchema: cjsSchema } = createRequire(import.meta.url)('@oxy.so/contracts');
const records = [];
const server = createServer(async (req, res) => {
 try {
  assert.ok(records.length < 10); assert.ok(['POST', 'DELETE'].includes(req.method));
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; assert.ok(size < 32768); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : undefined;
  records.push({ path: req.url, body, auth: req.headers.authorization, delegated: req.headers['x-oxy-user-id'] });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/auth/service-token') res.end(JSON.stringify({ token: 'synthetic-presenter', expiresIn: 3600, appName: 'fixture' }));
  else if (req.method === 'DELETE') {
   assert.equal(req.url, '/capabilities/execution-authorizations/synthetic-approval');
   assert.ok(['Bearer synthetic-ESM-requester', 'Bearer synthetic-CJS-requester'].includes(req.headers.authorization));
   assert.equal(req.headers['x-oxy-user-id'], undefined); assert.equal(body, undefined);
   res.statusCode = 204; res.end();
  } else {
   assert.equal(req.url, '/capabilities/foreground-execution-authorizations');
   assert.equal(req.headers.authorization, 'Bearer synthetic-presenter');
   assert.equal(req.headers['x-oxy-user-id'], undefined);
   res.statusCode = 201; res.end(JSON.stringify({ authorization: { id: 'synthetic-approval' } }));
  }
 } catch { res.statusCode = 400; res.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
 const input = { tool: 'readViewerGraph', expectedCatalog: { registrationId: 'r', version: '1.0.0', digest: 'a'.repeat(64) }, runId: 'run', expiresAt: '2026-10-03T10:00:00.000Z' };
 for (const [label, Server, schema] of [['ESM', ESMServer, esmSchema], ['CJS', CJSServer, cjsSchema]]) {
  const oxy = new Server({ baseURL: `http://127.0.0.1:${server.address().port}`, serviceAuth: { apiKey: label, apiSecret: 'synthetic-own-secret' } });
  assert.deepEqual(schema.parse(input), input);
  assert.deepEqual(await oxy.agency.createForegroundExecutionAuthorization(input, { requesterToken: `synthetic-${label}-requester` }), { id: 'synthetic-approval' });
  assert.deepEqual(records.at(-1).body, { ...input, subjectToken: `synthetic-${label}-requester` });
  await oxy.agency.revokeExecutionAuthorization('synthetic-approval', { requesterToken: `synthetic-${label}-requester` });
  assert.equal(records.at(-1).path, '/capabilities/execution-authorizations/synthetic-approval');
  const count = records.length;
  await assert.rejects(oxy.agency.createForegroundExecutionAuthorization(input, { requesterToken: 'invalid whitespace' }));
  await assert.rejects(oxy.agency.createForegroundExecutionAuthorization({ ...input, requesterAccountId: 'free-id' }, { requesterToken: 'synthetic' }));
  assert.equal(records.length, count);
  console.log(`${label}: installed foreground method/schema; independent service header/requester body and requester-only DELETE; malformed authority rejected before transport`);
 }
 assert.equal(records.length, 6);
 console.log('candidateOnly=true publishedAcceptance=false realAuthorityAcceptance=false remoteProviderRequests=0');
} finally { await new Promise(resolve => server.close(resolve)); }
