import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureParent = resolve(repository, '..');
const fixture = mkdtempSync(join(fixtureParent, 'i04-packed-consumer-'));
const dependencies = {};
const hashes = {};
for (const name of ['contracts', 'core', 'mcp', 'protocol', 'telemetry']) {
  const pkg = JSON.parse(readFileSync(join(repository, 'packages', name, 'package.json'), 'utf8'));
  const path = join(repository, 'packages', name, `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`);
  const bytes = readFileSync(path);
  dependencies[pkg.name] = `file:${path}`;
  hashes[pkg.name] = { version: pkg.version, sha256: createHash('sha256').update(bytes).digest('hex') };
}
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ private: true, dependencies,
  overrides: dependencies }, null, 2));
execFileSync('bun', ['install', '--minimum-release-age=0', '--ignore-scripts', '--omit=optional', '--omit=peer'], { cwd: fixture, stdio: 'inherit' });

const body = `
async function main() {
  for (const name of ['contracts', 'core', 'mcp']) {
    const loaded = realpathSync(resolvePackage('@oxy.so/' + name + '/package.json'));
    assert.ok(loaded.startsWith(fixture + '/'), 'consumer must resolve unpacked tarballs, never workspace source: ' + loaded);
  }
  const keys = generateKeyPairSync('ed25519');
  let service;
  const server = createServer((request, response) => { void service.handleMcp(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let active = true;
  let effects = 0;
  const catalog = contracts.appCapabilityCatalogSchema.parse({ schemaVersion: '1', appId: 'packed', version: '1', audience: 'packed-api', internalBaseUrl: origin, accountResourceType: 'workspace', events: [], tools: [{ name: 'read', version: '1', description: 'Packed fixture.', inputSchema: { type: 'object', properties: { resource: { type: 'string' } }, required: ['resource'], additionalProperties: false }, outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false }, capabilityPackage: 'read', requiredCapabilities: ['read'], resourceTypes: ['workspace'], effect: 'read', idempotency: 'required', rollback: 'none', exposure: ['internal'], limitKeys: [], invocation: { method: 'GET', path: '/read' } }] });
  const binding = { registrationId: 'packed-registration', version: catalog.version, digest: createHash('sha256').update(contracts.canonicalCapabilityJson(catalog)).digest('hex') };
  const ticket = core.issueCapabilityTicket({ aud: catalog.audience, sub: 'alia:owner', requesterAccountId: 'owner', ownerAccountId: 'owner', actor: { type: 'alia', ownerAccountId: 'owner' }, coordinator: { applicationId: 'alia', credentialId: 'credential' }, executionAuthorization: { kind: 'direct_request', id: 'operation' }, runId: 'run', catalog: binding, resource: { appId: 'packed', effectiveAccountId: 'workspace', resourceType: 'workspace', resourceId: 'resource-A' }, tool: 'read', capabilities: ['read'], limits: [], autonomy: 'read_only' }, { issuer: 'https://api.oxy.so', privateKey: keys.privateKey, keyId: 'packed-key' });
  const verification = { issuer: 'https://api.oxy.so', audience: catalog.audience, resolvePublicKey: () => keys.publicKey };
  const claims = core.verifyCapabilityTicket(ticket, verification);
  const verify = core.createLiveCapabilityTicketVerifier({ ...verification, introspect: async () => ({ active, claims }) });
  service = mcp.createInternalCatalogMcpHttpService({ catalog, binding, verifyTicket: verify, handlers: { read: async (_input, context) => { assert.equal(context.principal.kind, 'capability'); assert.equal(context.principal.claims.executionAuthorization.id, 'operation'); assert.equal(context.request.requestInfo.headers['idempotency-key'], 'packed-operation'); effects++; return { structuredContent: { count: effects } }; } }, resolveResource: (input, context) => ({ ...context.principal.claims.resource, resourceId: input.resource }), authorize: async () => ({ allowed: true, effectiveAccountId: 'workspace' }) });
  const captures = [];
  const client = mcp.createInternalCatalogMcpClient({ endpoint: origin + '/_oxy/mcp', fetch: async (url, init) => { captures.push({ headers: new Headers(init?.headers), body: String(init?.body ?? '') }); return fetch(url, init); } });
  try {
    assert.deepEqual((await client.listTools(ticket)).tools.map(tool => tool.name), ['read']);
    assert.equal(effects, 0);
    assert.equal((await client.callTool(ticket, 'read', { resource: 'resource-A' }, { idempotencyKey: 'packed-operation' })).structuredContent.count, 1);
    assert.equal((await client.callTool(ticket, 'read', { resource: 'resource-B' }, { idempotencyKey: 'packed-operation' })).isError, true);
    assert.equal(effects, 1);
    assert.equal((await client.callTool(ticket, 'read', { resource: 'resource-A' })).isError, true);
    assert.equal(effects, 1);
    assert.ok(captures.every(item => item.headers.get('authorization') === 'Capability ' + ticket && !item.headers.has('mcp-session-id') && !item.body.includes(ticket)));
    active = false;
    await assert.rejects(client.callTool(ticket, 'read', { resource: 'resource-A' }, { idempotencyKey: 'packed-operation' }));
    assert.equal(effects, 1);
    const oxy = new core.OxyServer({ baseURL: 'http://127.0.0.1:3999', serviceAuth: { apiKey: 'fixture', apiSecret: 'fixture' } });
    for (const method of ['serviceCatalogs', 'issueCapabilityTicket', 'introspectCapabilityTicket', 'createExecutionAuthorization']) assert.equal(typeof oxy.agency[method], 'function');
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log(mode + ': packed signature/live authority/client/key/resource/revocation assertions passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`;
for (const mode of ['cjs', 'esm']) {
  const preamble = mode === 'cjs' ? `
const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { createServer } = require('node:http');
const { realpathSync } = require('node:fs');
const contracts = require('@oxy.so/contracts');
const core = require('@oxy.so/core/server');
const mcp = require('@oxy.so/mcp');
const resolvePackage = require.resolve;
` : `
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as contracts from '@oxy.so/contracts';
import * as core from '@oxy.so/core/server';
import * as mcp from '@oxy.so/mcp';
const resolvePackage = id => fileURLToPath(import.meta.resolve(id));
`;
  const runner = join(fixture, `verify.${mode === 'cjs' ? 'cjs' : 'mjs'}`);
  writeFileSync(runner, `${preamble}\nconst fixture = ${JSON.stringify(fixture)};\nconst mode = ${JSON.stringify(mode)};\n${body}`);
  execFileSync(process.execPath, [runner], { cwd: fixture, stdio: 'inherit', timeout: 30000 });
}
writeFileSync(join(fixture, 'evidence.json'), JSON.stringify({ hashes, fixture, checkedAtUTC: new Date().toISOString(), modes: ['cjs', 'esm'], published: false }, null, 2));
assert.ok(Object.keys(hashes).length === 5);
console.log(JSON.stringify({ fixture, hashes, published: false }));
