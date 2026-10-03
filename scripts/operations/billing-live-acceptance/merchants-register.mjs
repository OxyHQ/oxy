/** Root-only bounded operator using the actual published Peable SDK; no customer/price creation. */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync, writeFileSync, fsyncSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APP = '6a37d0cc5d4b5f15482a9340';
const OWNER = '69b2d3df5d12f58c9800d651';
export const ARCHIVE_SHA = '68687dabc8caddcdb3f60d846d720f5103d29c4d2a0eacb774ebc08ca37f4494';
const SELF = fileURLToPath(import.meta.url);
function require(value, code) { if (!value) throw new Error(code); }
export function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function privateRead(path) {
  const parent = lstatSync(dirname(path));
  require(parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o777) === 0o700, 'private_parent_required');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = fstatSync(fd); require(s.isFile() && s.uid === process.getuid() && (s.mode & 0o777) === 0o600 && s.size <= 65536, 'private_file_required'); return readFileSync(fd); } finally { closeSync(fd); }
}
export function privateWrite(path, value) {
  const parent = lstatSync(dirname(path));
  require(parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o777) === 0o700, 'private_parent_required');
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const d = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(d); } finally { closeSync(d); }
}
export function validateMaterial(raw) {
  const m = JSON.parse(raw);
  require(Object.keys(m).sort().join() === 'publicKey,secret,secretHash' && /^oxy_dk_[a-f0-9]{48}$/.test(m.publicKey) && /^[a-f0-9]{64}$/.test(m.secret) && hash(m.secret) === m.secretHash, 'material_verifier_mismatch');
  return m;
}
export function validateIssue(issue) {
  const p = issue?.result?.plan;
  require(issue.mode === 'issue' && issue.result.operation === 'issue' && issue.result.state.status === 'active' && p.kind === 'mercaria-ephemeral-service-v1' && p.target.applicationId === APP && p.target.ownerAccountId === OWNER && /^[a-f0-9-]{36}$/.test(p.credentialId) && /^[a-f0-9]{24}$/.test(p.nonce), 'wrong_ephemeral_issue');
  require(Number.isFinite(Date.parse(p.issuedAt)) && Date.parse(p.issuedAt) <= Date.now() && Date.parse(p.expiresAt) > Date.now() && Date.parse(p.expiresAt) - Date.parse(p.issuedAt) <= 3600000, 'ephemeral_expired');
  return p;
}
export function verifySdk(root, archive, registryPath) {
  const bytes = readFileSync(archive); require(hash(bytes) === ARCHIVE_SHA, 'registry_archive_mismatch');
  const registryBytes = readFileSync(registryPath); const registry = JSON.parse(registryBytes);
  require(registry.version === '0.2.2' && registry.sha256 === ARCHIVE_SHA && registry.dist.fileCount === 53 && registry.dist.shasum === createHash('sha1').update(bytes).digest('hex') && registry.dist.integrity === 'sha512-' + createHash('sha512').update(bytes).digest('base64') && registry.dist.tarball === 'https://registry.npmjs.org/@peable.to/sdk/-/sdk-0.2.2.tgz', 'registry_metadata_mismatch');
  const entries = execFileSync('tar', ['-tzf', archive], { maxBuffer: 1024 * 1024 }).toString().trim().split('\n');
  const files = entries.filter(x => !x.endsWith('/'));
  require(files.length === 53 && new Set(files).size === 53, 'registry_file_census_mismatch');
  const inputs = [];
  for (const path of files) {
    require(/^package\/[a-zA-Z0-9_./-]+$/.test(path) && !path.split('/').includes('..'), 'registry_path_invalid');
    const relative = path.slice(8), installed = join(root, relative);
    const stat = lstatSync(installed); require(stat.isFile() && !stat.isSymbolicLink(), 'sdk_file_not_regular');
    const raw = execFileSync('tar', ['-xOzf', archive, path], { maxBuffer: 4 * 1024 * 1024 });
    require(hash(raw) === hash(readFileSync(installed)), 'sdk_installed_bytes_differ');
    inputs.push({ path: relative, sha256: hash(raw) });
  }
  function enumerate(path, prefix = '') { return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? enumerate(join(path, e.name), prefix + e.name + '/') : [prefix + e.name]); }
  require(enumerate(root).sort().join() === inputs.map(i => i.path).sort().join(), 'sdk_extra_files');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
  require(pkg.name === '@peable.to/sdk' && pkg.version === '0.2.2', 'sdk_wrong_version');
  return { files: inputs, registrySha256: hash(registryBytes), archiveSha256: ARCHIVE_SHA };
}
export function merchantIdentity(value) {
  require(value && value.object === 'merchant' && typeof value.id === 'string' && /^merch_[a-zA-Z0-9]+$/.test(value.id) && value.oxyAppId === APP && value.environment === 'development' && value.network === null && value.xpub === null && !value.webhookUrl, 'merchant_namespace_differs');
  return { id: value.id, oxyAppId: value.oxyAppId, environment: value.environment, network: null, xpub: null };
}
export function boundedFetch(nativeFetch, plan, material, record, persist) {
  const counts = { mint: 0, register: 0, retrieve: 0 };
  return async (input, init = {}) => {
    require(typeof input === 'string' && !init.redirect, 'transport_shape_invalid');
    const url = new URL(input), method = init.method ?? 'GET'; let phase;
    if (input === plan.oxyBase + '/auth/service-token' && method === 'POST') phase = 'mint';
    else if (input === plan.peableBase + '/v1/merchants/me' && method === 'GET') phase = 'retrieve';
    else if (input === plan.peableBase + '/v1/merchants' && method === 'POST') phase = 'register';
    else throw new Error('transport_outside_allowlist');
    require(Date.now() < plan.expiresAt && Date.now() < Date.parse(plan.ephemeral.expiresAt), 'operation_expired');
    require(++counts[phase] <= ({ mint: 2, register: 1, retrieve: 3 })[phase], 'transport_request_limit');
    if (phase === 'register') require(init.body === '{}', 'registration_body_not_empty');
    if (phase === 'mint') require(init.body === JSON.stringify({ apiKey: material.publicKey, apiSecret: material.secret }), 'mint_material_differs');
    // Receipt/intention precedes the only merchant mutation; never records body/header/token.
    persist({ phase, status: 'intent', ordinal: counts[phase] });
    let response;
    try { response = await nativeFetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(Math.min(10000, plan.expiresAt - Date.now())) }); }
    catch { persist({ phase, status: 'unknown', ordinal: counts[phase] }); throw new Error('transport_outcome_unknown'); }
    const reader = response.body?.getReader(); const chunks = []; let total = 0;
    if (reader) try { while (true) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; require(total <= 65536, 'response_oversized'); chunks.push(value); } } finally { await reader.cancel(); }
    const raw = Buffer.concat(chunks); require(Date.now() < plan.expiresAt && Date.now() < Date.parse(plan.ephemeral.expiresAt), 'operation_expired');
    persist({ phase, status: response.status, ordinal: counts[phase] });
    if (phase === 'mint' && response.ok) {
      const body = JSON.parse(Buffer.from(raw).toString()), token = body?.data?.token;
      require(typeof token === 'string' && Number.isInteger(body.data.expiresIn) && body.data.expiresIn > 0 && body.data.expiresIn <= 300, 'issuer_ttl_or_shape_invalid');
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
      require(claims.appId === APP && claims.credentialId === plan.ephemeral.credentialId && claims.environment === 'development' && claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 305 && Array.isArray(claims.scopes) && claims.scopes.length === 2 && ['payments:read', 'payments:write'].every(x => claims.scopes.includes(x)), 'issuer_claim_projection_differs');
      // Projection of HTTPS issuer response only; Peable performs JWT verification itself.
      record.issuer = { appId: claims.appId, credentialId: claims.credentialId, environment: claims.environment, expiresIn: body.data.expiresIn, scopes: claims.scopes };
    }
    return new Response(raw, { status: response.status, headers: response.headers });
  };
}
export async function registerOnce(Peable, plan, material, persist, nativeFetch = globalThis.fetch) {
  const record = { merchant: null, issuer: null, registered: false, reconciledAfterUnknown: false };
  const previous = globalThis.fetch; globalThis.fetch = boundedFetch(nativeFetch, plan, material, record, persist);
  try {
    const sdk = new Peable({ publicKey: material.publicKey, secret: material.secret, baseURL: plan.peableBase, oxyApiUrl: plan.oxyBase, requestTimeoutMs: 10000 });
    let existing;
    try { existing = await sdk.merchants.retrieve(); } catch (error) { require(error.statusCode === 404, 'merchant_preflight_not_absent'); }
    if (existing) { record.merchant = merchantIdentity(existing); return record; }
    let created;
    try { created = await sdk.merchants.register({}); record.registered = true; } catch { record.reconciledAfterUnknown = true; }
    // A timeout/conflict consumes the only POST budget. Readback may recover it; no second POST.
    const current = merchantIdentity(await sdk.merchants.retrieve());
    if (created) require(merchantIdentity(created).id === current.id, 'merchant_readback_differs');
    record.merchant = current; return record;
  } finally { globalThis.fetch = previous; }
}
async function main() {
  const [phase, configPath, output, expectedHash] = process.argv.slice(2);
  require(['prepare', 'execute'].includes(phase), 'operation_required');
  const bytes = privateRead(configPath), config = JSON.parse(bytes);
  if (phase === 'prepare') {
    require(Object.keys(config).sort().join() === 'archive,ephemeralIssue,material,registry,sdkRoot', 'configuration_fields_invalid');
    const sdk = verifySdk(config.sdkRoot, config.archive, config.registry), ephemeral = validateIssue(JSON.parse(privateRead(config.ephemeralIssue)));
    validateMaterial(privateRead(config.material));
    const plan = { kind: 'mercaria-technical-merchant-register', schemaVersion: 1, nonce: randomBytes(16).toString('hex'), preparedAt: Date.now(), expiresAt: Math.min(Date.now() + 1800000, Date.parse(ephemeral.expiresAt)), sourceSha256: hash(readFileSync(SELF)), config, sdk, ephemeral, issueSha256: hash(privateRead(config.ephemeralIssue)), materialSha256: hash(privateRead(config.material)), oxyBase: 'https://api.oxy.so', peableBase: 'https://api.peable.to' };
    privateWrite(output, plan); console.log(JSON.stringify({ prepared: true, planSha256: hash(readFileSync(output)), executed: false })); return;
  }
  require(hash(bytes) === expectedHash && config.kind === 'mercaria-technical-merchant-register' && config.schemaVersion === 1 && config.sourceSha256 === hash(readFileSync(SELF)) && config.oxyBase === 'https://api.oxy.so' && config.peableBase === 'https://api.peable.to' && config.preparedAt <= Date.now() && config.expiresAt > Date.now() && config.expiresAt - config.preparedAt <= 1800000, 'plan_changed_or_expired');
  require(JSON.stringify(verifySdk(config.config.sdkRoot, config.config.archive, config.config.registry)) === JSON.stringify(config.sdk), 'sdk_inputs_changed');
  require(hash(privateRead(config.config.ephemeralIssue)) === config.issueSha256 && hash(privateRead(config.config.material)) === config.materialSha256, 'ephemeral_inputs_changed');
  validateIssue(JSON.parse(privateRead(config.config.ephemeralIssue))); const material = validateMaterial(privateRead(config.config.material));
  privateWrite(output + '.intent.json', { nonce: config.nonce, credentialId: config.ephemeral.credentialId, applicationId: APP, planSha256: expectedHash, cleanupRequired: true });
  let ordinal = 0;
  const persist = event => privateWrite(output + '.event-' + (++ordinal) + '.json', { nonce: config.nonce, ...event });
  try {
    const { Peable } = await import(pathToFileURL(join(config.config.sdkRoot, 'dist/esm/index.js')).href);
    const result = await registerOnce(Peable, config, material, persist);
    privateWrite(output, { nonce: config.nonce, successful: true, ...result, cleanupRequired: true, providerPaymentsActivated: false });
    console.log(JSON.stringify({ complete: true, credentialCleanupPending: true, providerPaymentsActivated: false }));
  } catch {
    privateWrite(output, { nonce: config.nonce, successful: false, outcome: 'reconcile_owned_application_and_environment', cleanupRequired: true });
    console.log(JSON.stringify({ complete: false, credentialCleanupPending: true })); process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) main().catch(() => { console.error('MERCHANT_OPERATOR_FAILED: reconcile private intent and revoke exact ephemeral credential'); process.exitCode = 1; });
