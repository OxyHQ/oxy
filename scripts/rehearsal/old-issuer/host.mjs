/** Same host wrapper for exact old/final source trees. No authentication substitutes. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const [source, portText, ready] = process.argv.slice(2);
assert(source && portText && ready && process.argv.length === 5);
const port = Number(portText);
assert([17974, 17975].includes(port));
const db = new URL(process.env.DATABASE_URL);
assert(db.hostname === '127.0.0.1' && db.port === '5599' && /^\/oxy_rollback_[a-f0-9]{16}$/.test(db.pathname));
assert(process.env.NODE_ENV === 'test' && !existsSync(resolve('.env')));
const require = createRequire(join(source, 'packages/api/package.json'));
// Reject external effects before loading any product source. PostgreSQL and
// HTTP are permitted only on this rehearsal's three loopback ports.
const allowed = new Set([5598, 5599, 17974, 17975]);
let externalAttempts = 0;
writeFileSync(ready + '.external.json', JSON.stringify({externalAttempts}), {mode:0o600,flag:'wx'});
function check(host, p) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !allowed.has(Number(p))) {
    externalAttempts++;
    writeFileSync(ready + '.external.json', JSON.stringify({externalAttempts}), {mode:0o600});
    throw new Error('rollback_external_io_denied');
  }
}
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  if (options && typeof options === 'object') check(options.host ?? 'localhost', options.port);
  else check(typeof args[1] === 'string' ? args[1] : 'localhost', options);
  return originalConnect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = new URL(input instanceof Request ? input.url : String(input));
  check(u.hostname, u.port || (u.protocol === 'https:' ? 443 : 80));
  return originalFetch(input, init);
};
const { connectPostgres, closePostgres } = require(join(source, 'packages/api/src/config/postgres.ts'));
await connectPostgres();
const { default: server } = require(join(source, 'packages/api/src/server.ts'));
// Explicit provider seam: no AWS request/signature is exercised. The real
// nonce store, DB binding, live authority and mint remain unchanged.
const attestation = require(join(source, 'packages/api/src/services/workloadAttestation.service.ts'));
attestation.registerAttestationVerifier({provider:'aws-iam',verify:async(payload,nonce)=>{
  assert(payload && payload.answersNonce===nonce && payload.subject==='rollback-owned-workload');
  return {provider:'aws-iam',subject:payload.subject,attestationId:attestation.workloadAttestationHandle(payload.subject)};
}});

await new Promise((done) => server.listen(port, '127.0.0.1', done));
writeFileSync(ready, JSON.stringify({ pid: process.pid, source, port, ready: true }), { mode: 0o600, flag: 'wx' });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  require(join(source, 'packages/api/src/config/dynamicOriginRegistry.ts')).stopOriginRegistry();
  require(join(source, 'packages/api/src/utils/socket.ts')).closeIO();
  await new Promise((done) => server.close(done));
  await closePostgres();
  console.log(JSON.stringify({ stopped: true, pid: process.pid, externalAttempts }));
  process.exit(externalAttempts ? 2 : 0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
